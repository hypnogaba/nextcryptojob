import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/lib/auth/hash";
import { getAction } from "@/lib/crm/actions";
import { respondToIntro } from "@/lib/crm/intros";
import { sqlTime } from "@/lib/time";
import { rest, schemaErrors, setupApi } from "@/test/api-fixtures";
import { addApiKey, addCompany, addSubscription, addUsage, addUser, all, publishFormula, run } from "@/test/crm-fixtures";
import { addCandidate, BOT_TOKEN, MESSAGE, type Network } from "@/test/intro-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { DELETE, GET, PATCH, POST, PUT } from "./route";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);

/**
 * REST API через справжній маршрут: вхід ключем, межі компаній, приватність
 * кандидата, квоти й сплески, розбір запиту, 501 і відповідність схемам openapi.yaml.
 * Оплату x402 перевіряє x402.test.ts поруч.
 */

const HANDLERS = { GET, POST, PUT, PATCH, DELETE } as const;
type Method = keyof typeof HANDLERS;
const call = (method: Method, path: string, o: Parameters<typeof rest>[3] = {}) => rest(HANDLERS[method], method, path, o);

let db: TestDb;
let net: Network;

beforeEach(() => {
  ({ db, net } = setupApi());
  publishFormula(db.raw);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function company(o: { subscribed?: boolean; name?: string; status?: string } = {}) {
  const co = addCompany(db.raw, { name: o.name ?? "Acme Labs", status: o.status });
  if (o.subscribed ?? true) addSubscription(db.raw, co);
  const { id: keyId, key } = await addApiKey(db.raw, co, { name: "sourcing-bot" });
  return { co, keyId, key };
}

const noEvenPartialContact = /alice_eth|@gmail|example\.com|0x[0-9a-f]{40}/i;

describe("authentication", () => {
  it("without a key the API answers 401 unauthorized with a request id, and never touches the facilitator", async () => {
    for (const [method, path] of [["GET", "/me"], ["GET", "/pipeline"], ["POST", "/intros"], ["GET", "/usage"]] as const) {
      const res = await call(method, path, method === "POST" ? { body: { candidate_id: crypto.randomUUID(), message: MESSAGE } } : {});
      expect({ path, status: res.status, code: res.body.error.code }).toEqual({ path, status: 401, code: "unauthorized" });
      expect(res.body.error.request_id).toBe(res.headers.get("X-Request-Id"));
      expect(schemaErrors(method, path, res)).toEqual([]);
    }
    expect(net.verify + net.settle).toBe(0);
  });

  it("tells a malformed, an unknown and a revoked key apart", async () => {
    const { co } = await company();
    const { key: revoked } = await addApiKey(db.raw, co, { revoked: true });
    const unknown = `ncj_live_${"A".repeat(43)}`;
    expect((await call("GET", "/me", { key: "not-a-key" })).body.error.code).toBe("invalid_api_key");
    expect((await call("GET", "/me", { key: unknown })).body.error.code).toBe("invalid_api_key");
    const res = await call("GET", "/me", { key: revoked });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: "key_revoked", message: "This API key was revoked." });
  });

  it("a key of a suspended company is refused with company_not_active", async () => {
    const { key } = await company({ status: "suspended" });
    const res = await call("GET", "/pipeline", { key });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("company_not_active");
  });

  it("an x402 payment is not an identity: a guest cannot request intros or read a pipeline", async () => {
    const payment = "e30"; // любий платіж: до шлюзу справа не доходить
    const intro = await call("POST", "/intros", { payment, body: { candidate_id: crypto.randomUUID(), message: MESSAGE } });
    expect(intro.status).toBe(401);
    expect(intro.body.error.code).toBe("key_required");
    expect((await call("GET", "/pipeline", { payment })).body.error.code).toBe("key_required");
    expect(net.verify).toBe(0);
    expect(all(db.raw, "SELECT id FROM x402_payments")).toEqual([]);
  });

  it("the key answers for its own company: /me names the company, the access mode and the key", async () => {
    const { co, keyId, key } = await company();
    const res = await call("GET", "/me", { key });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      company: { company_id: co, name: "Acme Labs", kind: "company", status: "active" },
      access: { mode: "subscription", trial: false },
      key: { key_id: keyId, name: "sourcing-bot" },
      quotas: { search_candidates: { limit: 300, remaining: 300 } },
    });
    expect(schemaErrors("GET", "/me", res)).toEqual([]);
  });
});

describe("tenant isolation", () => {
  it("another company's key sees none of the cards, notes or intros and cannot change them", async () => {
    const a = await company({ name: "Acme Labs" });
    const b = await company({ name: "Other Co" });
    const alice = addCandidate(db);
    expect((await call("PUT", `/pipeline/${alice.id}`, { key: a.key, body: { tags: ["solidity"] } })).status).toBe(201);
    expect((await call("POST", `/pipeline/${alice.id}/notes`, { key: a.key, body: { body: "Strong audits" } })).status).toBe(201);
    const intro = await call("POST", "/intros", { key: a.key, body: { candidate_id: alice.id, message: MESSAGE } });
    expect(intro.status).toBe(201);
    const introId = intro.body.intro_id as string;

    expect((await call("GET", "/pipeline", { key: b.key })).body).toMatchObject({ data: [], next_cursor: null });
    expect((await call("GET", "/intros", { key: b.key })).body.data).toEqual([]);
    for (const [method, path, body] of [
      ["GET", `/intros/${introId}`],
      ["POST", `/intros/${introId}/cancel`],
      ["GET", `/pipeline/${alice.id}/events`],
      ["PATCH", `/pipeline/${alice.id}`, { stage: "declined" }],
      ["POST", `/pipeline/${alice.id}/notes`, { body: "mine now" }],
      ["DELETE", `/pipeline/${alice.id}`],
    ] as [Method, string, unknown?][]) {
      const res = await call(method, path, { key: b.key, body });
      expect({ method, path, status: res.status, code: res.body?.error?.code }).toEqual({ method, path, status: 404, code: "not_found" });
    }
    // У компанії A нічого не змінилось.
    const card = (await call("GET", "/pipeline", { key: a.key })).body.data[0];
    expect(card).toMatchObject({ candidate_id: alice.id, stage: "intro_requested", tags: ["solidity"], note_count: 1 });
    expect((await call("GET", `/intros/${introId}`, { key: a.key })).body.status).toBe("pending");
    // B бачить кандидата в пошуку як будь-кого іншого, без картки A.
    const profile = await call("GET", `/candidates/${alice.id}`, { key: b.key });
    expect(profile.body).toMatchObject({ visibility: "visible", pipeline: null, intro: null, contact: null });
  });
});

describe("candidate privacy", () => {
  it("no route shows a handle, an email or a wallet before the candidate accepts, and only the asking company sees it after", async () => {
    const a = await company({ name: "Acme Labs" });
    const b = await company({ name: "Other Co" });
    const alice = addCandidate(db); // Telegram @alice_eth, пошта @gmail.com
    run(db.raw, "INSERT INTO identities (user_id, kind, value) VALUES (?, 'evm', ?)", alice.id, `0x${"ab".repeat(20)}`);

    const search = await call("POST", "/candidates/search", { key: a.key, body: { filters: { role: "engineer" } } });
    expect(search.body.data.map((d: { candidate_id: string }) => d.candidate_id)).toEqual([alice.id]);
    const intro = await call("POST", "/intros", { key: a.key, body: { candidate_id: alice.id, message: MESSAGE } });
    const before = [
      search,
      intro,
      await call("GET", `/candidates/${alice.id}`, { key: a.key }),
      await call("GET", `/intros/${intro.body.intro_id}`, { key: a.key }),
      await call("GET", "/intros", { key: a.key }),
      await call("GET", "/pipeline", { key: a.key }),
      await call("GET", `/pipeline/${alice.id}/events`, { key: a.key }),
    ];
    for (const res of before) expect(JSON.stringify(res.body)).not.toMatch(noEvenPartialContact);
    expect(intro.body.contact).toBeNull();

    const outcome = await respondToIntro(db.d1, {
      introId: intro.body.intro_id,
      userId: alice.id,
      decision: "accept",
      via: "web",
      notifier: { botToken: BOT_TOKEN, mailer: null, origin: "https://nextcryptojob.xyz" },
    });
    expect(outcome.kind).toBe("accepted");

    const shared = { kind: "telegram", value: "@alice_eth", via: "intro" };
    expect((await call("GET", `/intros/${intro.body.intro_id}`, { key: a.key })).body.contact).toMatchObject(shared);
    expect((await call("GET", `/candidates/${alice.id}`, { key: a.key })).body.contact).toMatchObject(shared);
    // Інша компанія контакту не отримує ні профілем, ні пошуком.
    const other = [
      await call("GET", `/candidates/${alice.id}`, { key: b.key }),
      await call("POST", "/candidates/search", { key: b.key, body: {} }),
    ];
    for (const res of other) expect(JSON.stringify(res.body)).not.toMatch(noEvenPartialContact);
  });

  it("a candidate who is not visible is not available, even by id", async () => {
    const { key } = await company();
    const hidden = addCandidate(db, { visible: false });
    const res = await call("GET", `/candidates/${hidden.id}`, { key });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("candidate_not_available");
    expect((await call("POST", "/candidates/search", { key, body: {} })).body.data).toEqual([]);
  });
});

describe("quotas and burst limits", () => {
  it("the 301st search of the day is refused with 429 and RateLimit headers; nothing is counted for it", async () => {
    const { co, key } = await company();
    addUser(db.raw);
    addUsage(db.raw, 299, { companyId: co, action: "search_candidates", at: sqlTime(new Date()) });
    const last = await call("POST", "/candidates/search", { key, body: {} });
    expect(last.status).toBe(200);
    expect(last.headers.get("RateLimit-Limit")).toBe("300");
    expect(last.headers.get("RateLimit-Remaining")).toBe("0");
    const over = await call("POST", "/candidates/search", { key, body: {} });
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe("daily_quota_exceeded");
    expect(over.body.error.message).toBe("Daily search limit reached. It resets at 00:00 UTC.");
    expect(over.headers.get("RateLimit-Remaining")).toBe("0");
    expect(Number(over.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(all(db.raw, "SELECT COUNT(*) AS n FROM usage_events WHERE company_id = ? AND status = 200", co)).toEqual([{ n: 300 }]);
  });

  it("the monthly intro quota is a 403 quota_exceeded, and no candidate is asked", async () => {
    // Stripe: місяць квоти = період підписки (почався 10 днів тому), тож 40 знайомств 3 дні тому вичерпують лише місяць.
    const co = addCompany(db.raw);
    const day = 86_400_000;
    addSubscription(db.raw, co, {
      provider: "stripe",
      start: sqlTime(new Date(Date.now() - 10 * day)),
      end: sqlTime(new Date(Date.now() + 20 * day)),
    });
    const { key } = await addApiKey(db.raw, co);
    const alice = addCandidate(db);
    addUsage(db.raw, 40, { companyId: co, action: "request_intro", at: sqlTime(new Date(Date.now() - 3 * day)) });
    const res = await call("POST", "/intros", { key, body: { candidate_id: alice.id, message: MESSAGE } });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: "quota_exceeded", details: { quota: "request_intro_month", limit: 40 } });
    expect(all(db.raw, "SELECT id FROM intros")).toEqual([]);
    expect(net.messagesTo(alice.telegramId!)).toEqual([]);
  });

  it("the burst limit runs first: per key for agents, per IP for guests, before the body or the key is read", async () => {
    const seen: string[] = [];
    const limiter = (success: boolean) => ({ limit: async ({ key }: { key: string }) => (seen.push(key), { success }) });
    ({ db, net } = setupApi({ RL_API: limiter(false) as never, RL_IP: limiter(false) as never, RL_PUBLIC: limiter(false) as never }));
    const { key } = await company();
    const agent = await call("GET", "/pipeline", { key });
    expect(agent.status).toBe(429);
    expect(agent.body.error.code).toBe("rate_limited");
    expect(agent.headers.get("Retry-After")).toBe("60");
    expect(seen[0]).toBe(`key:${(await sha256Hex(key)).slice(0, 32)}`);

    // Хибний ключ і зіпсоване тіло: 429 раніше за 401 і 422, тобто ні D1, ні тіла не читали.
    const d1 = vi.spyOn(db.d1, "prepare");
    const bogus = await call("POST", "/candidates/search", { key: `ncj_live_${"Q".repeat(43)}`, raw: "{nope" });
    expect(bogus.status).toBe(429);
    const guest = await call("POST", "/candidates/search", { raw: "{nope", headers: { "cf-connecting-ip": "203.0.113.7" } });
    expect(guest.body.error.code).toBe("rate_limited");
    const open = await call("GET", "/public/jobs", { headers: { "cf-connecting-ip": "203.0.113.8" } });
    expect(open.status).toBe(429);
    expect(d1).not.toHaveBeenCalled();
    expect(seen.slice(2)).toEqual(["ip:203.0.113.7", "ip:203.0.113.8"]);
    expect(net.verify).toBe(0);
  });
});

describe("request parsing and routing", () => {
  it("unknown paths are 404 and a wrong method is 405 with Allow, both as JSON errors", async () => {
    const { key } = await company();
    const missing = await call("GET", "/nope", { key });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("not_found");
    const wrong = await call("DELETE", "/intros", { key });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("Allow")).toBe("POST, GET");
    // /candidates/search не профіль кандидата "search".
    expect((await call("GET", "/candidates/search", { key })).status).toBe(405);
  });

  it("broken JSON, unknown fields and a path id repeated differently in the body are 422 with field messages", async () => {
    const { key } = await company();
    const alice = addCandidate(db);
    const broken = await call("POST", "/candidates/search", { key, raw: "{nope" });
    expect(broken.status).toBe(422);
    expect(broken.body.error.details.fields).toEqual({ "(body)": "The request body is not valid JSON." });
    const extra = await call("POST", "/candidates/search", { key, body: { filters: { age: 30 } } });
    expect(extra.status).toBe(422);
    expect(extra.body.error.code).toBe("validation_failed");
    const other = crypto.randomUUID();
    const conflict = await call("PUT", `/pipeline/${alice.id}`, { key, body: { candidate_id: other } });
    expect(conflict.body.error.details.fields).toHaveProperty("candidate_id");
    expect(all(db.raw, "SELECT id FROM pipeline")).toEqual([]);
  });

  it("query parameters become typed input: limit pages the pipeline", async () => {
    const { key } = await company();
    for (let i = 0; i < 3; i++) await call("PUT", `/pipeline/${addCandidate(db).id}`, { key });
    const page = await call("GET", "/pipeline?limit=2", { key });
    expect(page.status).toBe(200);
    expect(page.body.data).toHaveLength(2);
    const next = await call("GET", `/pipeline?limit=2&cursor=${encodeURIComponent(page.body.next_cursor)}`, { key });
    expect(next.body.data).toHaveLength(1);
    expect((await call("GET", "/pipeline?limit=zero", { key })).status).toBe(422);
    expect((await call("GET", "/pipeline?colour=red", { key })).status).toBe(422);
  });

  it("an operation that is not live yet answers 501 not_implemented before anything else", async () => {
    // Усі 28 уже працюють: обробник платного пошуку знімаємо на час тесту, як у нової дії.
    const def = getAction("search_candidates")!;
    const handler = def.handler;
    delete def.handler;
    try {
      const { key } = await company({ subscribed: false });
      const res = await call("POST", "/candidates/search", { key, body: { nonsense: true } });
      expect(res.status).toBe(501);
      expect(res.body.error.code).toBe("not_implemented");
      expect(net.verify + net.settle).toBe(0);
    } finally {
      def.handler = handler;
    }
  });
});

describe("every one of the 28 operations answers with the schema of openapi.yaml", () => {
  it("success bodies, 402 and errors validate against the contract", async () => {
    const { key } = await company();
    const alice = addCandidate(db);
    const bob = addCandidate(db);
    const results: { op: string; status: number; errors: string[] }[] = [];
    const check = async (method: Method, template: string, path: string, body?: unknown) => {
      const res = await call(method, path, { key, body });
      results.push({ op: `${method} ${template}`, status: res.status, errors: schemaErrors(method, template, res) });
      return res;
    };

    await check("GET", "/me", "/me");
    await check("POST", "/candidates/search", "/candidates/search", { filters: { role: "engineer" }, limit: 5 });
    await check("GET", "/candidates/{candidate_id}", `/candidates/${alice.id}`);
    await check("PUT", "/pipeline/{candidate_id}", `/pipeline/${alice.id}`, { tags: ["solidity"] });
    await check("GET", "/pipeline", "/pipeline");
    await check("PATCH", "/pipeline/{candidate_id}", `/pipeline/${alice.id}`, { tags: ["solidity", "lending"] });
    await check("POST", "/pipeline/{candidate_id}/notes", `/pipeline/${alice.id}/notes`, { body: "Strong audits" });
    await check("GET", "/pipeline/{candidate_id}/events", `/pipeline/${alice.id}/events`);
    const intro = await check("POST", "/intros", "/intros", { candidate_id: bob.id, message: MESSAGE });
    await check("GET", "/intros", "/intros");
    await check("GET", "/intros/{intro_id}", `/intros/${intro.body.intro_id}`);
    await check("POST", "/intros/{intro_id}/cancel", `/intros/${intro.body.intro_id}/cancel`);
    await check("DELETE", "/pipeline/{candidate_id}", `/pipeline/${alice.id}`);
    await check("GET", "/jobs", "/jobs");
    const posted = await check("POST", "/jobs", "/jobs", {
      title: "Solidity engineer",
      roles: ["engineer"],
      work_mode: ["remote"],
      salary: { min: 120000, max: 150000, currency: "USD", period: "year" },
      apply_url: "https://acme.io/jobs/solidity",
      status: "open",
      post_on_x: true,
    });
    const job = posted.body.job_id as string;
    await check("GET", "/jobs/{job_id}", `/jobs/${job}`);
    await check("PATCH", "/jobs/{job_id}", `/jobs/${job}`, { title: "Senior Solidity engineer" });
    await check("POST", "/jobs/{job_id}/close", `/jobs/${job}/close`);
    await check("GET", "/saved-searches", "/saved-searches");
    const saved = await check("POST", "/saved-searches", "/saved-searches", { name: "Solidity", filters: { role: "engineer" } });
    const ss = saved.body.saved_search_id as string;
    await check("PATCH", "/saved-searches/{saved_search_id}", `/saved-searches/${ss}`, { alert: "off" });
    await check("DELETE", "/saved-searches/{saved_search_id}", `/saved-searches/${ss}`);
    await check("GET", "/webhook", "/webhook");
    await check("PUT", "/webhook", "/webhook", { url: "https://acme.io/hooks/ncj" });
    await check("POST", "/webhook/test", "/webhook/test");
    await check("GET", "/usage", "/usage");
    await check("POST", "/billing/usdc-month", "/billing/usdc-month");
    await check("GET", "/public/jobs", "/public/jobs");

    expect(results).toHaveLength(28);
    expect(results.filter((r) => r.errors.length > 0)).toEqual([]);
    const live = Object.fromEntries(results.map((r) => [r.op, r.status]));
    expect(live).toMatchObject({
      "GET /me": 200,
      "POST /candidates/search": 200,
      "GET /candidates/{candidate_id}": 200,
      "PUT /pipeline/{candidate_id}": 201,
      "PATCH /pipeline/{candidate_id}": 200,
      "POST /pipeline/{candidate_id}/notes": 201,
      "GET /pipeline/{candidate_id}/events": 200,
      "POST /intros": 201,
      "GET /intros/{intro_id}": 200,
      "POST /intros/{intro_id}/cancel": 200,
      "DELETE /pipeline/{candidate_id}": 204,
      "GET /saved-searches": 200,
      "POST /saved-searches": 201,
      "PATCH /saved-searches/{saved_search_id}": 200,
      "DELETE /saved-searches/{saved_search_id}": 204,
      "GET /usage": 200,
      "GET /jobs": 200,
      "POST /jobs": 201,
      "GET /jobs/{job_id}": 200,
      "PATCH /jobs/{job_id}": 200,
      "POST /jobs/{job_id}/close": 200,
      "GET /public/jobs": 200,
      // Місяць USDC платний навіть з підпискою: без платежу 402 з вимогою.
      "POST /billing/usdc-month": 402,
      // Вебхук (T11): читання працює; без WEBHOOK_SIGNING_KEY зміна каже, чого бракує (503),
      // а тест без адреси відповідає 409 webhook_not_set.
      "GET /webhook": 200,
      "PUT /webhook": 503,
      "POST /webhook/test": 409,
    });
    // Усі 28 операцій уже працюють: жодної 501.
    expect(results.filter((r) => r.status === 501).map((r) => r.op)).toEqual([]);
  });
});
