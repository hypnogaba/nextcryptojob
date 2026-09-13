import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, crmDb, publishFormula, run } from "@/test/crm-fixtures";
import {
  addCandidate,
  addTestCompany,
  ask,
  BOT_TOKEN,
  NOW,
  rejection,
  stubNetwork,
  type Network,
  type TestCompany,
} from "@/test/intro-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { runAction } from "./actions";
import { contextFor } from "@/test/crm-fixtures";
import { loadCompany } from "./context";
import { respondToIntro } from "./intros";
import { Intro } from "./types";
import {
  deliverWebhooks,
  MAX_ATTEMPTS,
  recentDeliveries,
  signatureHeader,
  verifySignature,
  webhookSecret,
  webhookUrlProblem,
} from "./webhooks";

/**
 * Вебхук компанії (специфікація 7.6): секрет і підпис, захист адреси, дії
 * реєстру, доставка з повторами за розкладом, ідемпотентність cron, межі компаній.
 * Мережа на заглушці: приймачі вебхуків (hooks.*) і Bot API.
 */

const KEY = "test-webhook-signing-key-0123456789abcdef";

interface Hit {
  url: string;
  headers: Record<string, string>;
  body: string;
  redirect: RequestRedirect | undefined;
}

interface Receivers {
  hits: Hit[];
  /** Відповідь приймача за адресою: статус або помилка мережі. */
  answer: (url: string, n: number) => number | Error;
}

let db: TestDb;
let net: Network;
let hooks: Receivers;

/** Приймачі вебхуків на hooks.* поверх заглушки Bot API і фасилітатора. */
function stubReceivers(): Receivers {
  const r: Receivers = { hits: [], answer: () => 200 };
  const base = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (new URL(url).hostname.startsWith("hooks.")) {
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      r.hits.push({ url, headers, body: String(init?.body), redirect: init?.redirect });
      const a = r.answer(url, r.hits.length);
      if (a instanceof Error) throw a;
      const redirect = a >= 300 && a < 400;
      return new Response(redirect || a === 204 ? null : "ok", { status: a, headers: redirect ? { Location: "http://127.0.0.1/" } : {} });
    }
    return base(input, init);
  });
  return r;
}

beforeEach(() => {
  db = crmDb();
  publishFormula(db.raw);
  net = stubNetwork();
  hooks = stubReceivers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const notifier = { botToken: BOT_TOKEN, mailer: null, origin: "https://nextcryptojob.xyz" };
const env = { WEBHOOK_SIGNING_KEY: KEY, SITE_URL: "https://nextcryptojob.xyz", TELEGRAM_BOT_TOKEN: BOT_TOKEN };
const at = (ms: number) => new Date(NOW.getTime() + ms);
const MIN = 60_000;
const HOUR = 60 * MIN;
const intro = (id: string) => all<Record<string, unknown>>(db.raw, "SELECT * FROM intros WHERE id = ?", id)[0];

async function company(name = "Acme Labs", url: string | null = "https://hooks.acme.io/ncj"): Promise<TestCompany> {
  const c = await addTestCompany(db, net, { name, env: { WEBHOOK_SIGNING_KEY: KEY } });
  if (url) await runAction("set_webhook", { url }, c.agent);
  return c;
}

/** Знайомство, на яке кандидат відповів: подія на черзі вебхука. */
async function answered(c: TestCompany, decision: "accept" | "decline" = "accept", when = NOW): Promise<{ introId: string; userId: string }> {
  const who = addCandidate(db);
  const introId = (await ask(c.agent, who.id)).output.intro_id;
  await respondToIntro(db.d1, { introId, userId: who.id, decision, via: "web", now: when, notifier });
  return { introId, userId: who.id };
}

describe("secret and signature", () => {
  it("derives a stable secret per company and version without storing it", async () => {
    const a1 = await webhookSecret(KEY, "co_A", 1);
    expect(a1).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(await webhookSecret(KEY, "co_A", 1)).toBe(a1);
    expect(await webhookSecret(KEY, "co_A", 2)).not.toBe(a1);
    expect(await webhookSecret(KEY, "co_B", 1)).not.toBe(a1);
    expect(await webhookSecret("another-key", "co_A", 1)).not.toBe(a1);
  });

  it("a receiver accepts the signed body and rejects a changed body, another secret or an old timestamp", async () => {
    const secret = await webhookSecret(KEY, "co_A", 1);
    const body = JSON.stringify({ id: "evt_1", type: "ping" });
    const t = Math.floor(NOW.getTime() / 1000);
    const header = await signatureHeader([secret], body, t);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(await verifySignature(header, body, secret, NOW)).toBe(true);
    expect(await verifySignature(header, body.replace("ping", "pong"), secret, NOW)).toBe(false);
    expect(await verifySignature(header, body, await webhookSecret(KEY, "co_B", 1), NOW)).toBe(false);
    expect(await verifySignature(header, body, secret, at(301_000))).toBe(false);
    expect(await verifySignature(header, body, secret, at(299_000))).toBe(true);
    // Під час ротації два v1: годиться будь-який.
    const old = await webhookSecret(KEY, "co_A", 0);
    const both = await signatureHeader([secret, old], body, t);
    expect(await verifySignature(both, body, old, NOW)).toBe(true);
    expect(await verifySignature(both, body, secret, NOW)).toBe(true);
  });
});

describe("webhook URL guard (SSRF)", () => {
  it.each([
    ["http://acme.io/hooks", "Use an https:// URL."],
    ["ftp://acme.io/hooks", "Use an https:// URL."],
    ["acme.io/hooks", "Enter a full URL that starts with https://."],
    ["https://127.0.0.1/hooks", "IP addresses"],
    ["https://10.0.0.8/hooks", "IP addresses"],
    ["https://169.254.169.254/latest/meta-data", "IP addresses"],
    ["https://[::1]/hooks", "IP addresses"],
    ["https://[fd00::1]/hooks", "IP addresses"],
    ["https://2130706433/hooks", "IP addresses"],
    ["https://0x7f.1/hooks", "IP addresses"],
    ["https://localhost/hooks", "IP addresses"],
    ["https://api.localhost/hooks", "IP addresses"],
    ["https://intranet/hooks", "IP addresses"],
    ["https://printer.local/hooks", "IP addresses"],
    ["https://db.internal/hooks", "IP addresses"],
    ["https://user:pass@acme.io/hooks", "user name and password"],
    ["https://acme.io:8443/hooks", "port (443)"],
    ["https://nextcryptojob.xyz/api/v1/me", "NextCryptoJob"],
    ["https://api.nextcryptojob.xyz/hook", "NextCryptoJob"],
    [`https://acme.io/${"a".repeat(500)}`, "at most 500"],
  ])("refuses %s", (url, reason) => {
    expect(webhookUrlProblem(url)).toContain(reason);
  });

  it("accepts a public https endpoint, with a query token and the default port written out", () => {
    expect(webhookUrlProblem("https://hooks.acme.io/ncj?token=abc")).toBeNull();
    expect(webhookUrlProblem("https://Hooks.Example.co.uk:443/x")).toBeNull();
  });
});

describe("set_webhook, get_webhook", () => {
  it("says what is missing without WEBHOOK_SIGNING_KEY", async () => {
    const c = await addTestCompany(db, net);
    expect(await rejection(runAction("set_webhook", { url: "https://hooks.acme.io/ncj" }, c.agent))).toMatchObject({
      code: "not_configured",
      status: 503,
      message: "not configured: WEBHOOK_SIGNING_KEY",
    });
    expect(await rejection(runAction("test_webhook", {}, c.agent))).toMatchObject({ code: "webhook_not_set", status: 409 });
    // Адресу поставили, коли ключ ще був: тест без ключа каже, чого бракує.
    run(db.raw, "UPDATE companies SET webhook_url = 'https://hooks.acme.io/ncj', webhook_enabled = 1 WHERE id = ?", c.co);
    expect(await rejection(runAction("test_webhook", {}, c.agent))).toMatchObject({ code: "not_configured", status: 503 });
  });

  it("shows the secret only for the first URL and after a rotation; later reads never show it", async () => {
    const c = await company("Acme Labs", null);
    const first = (await runAction("set_webhook", { url: "https://hooks.acme.io/ncj#frag" }, c.agent)).output;
    expect(first).toMatchObject({ url: "https://hooks.acme.io/ncj", enabled: true, secret: await webhookSecret(KEY, c.co, 1) });
    expect((await runAction("get_webhook", {}, c.owner)).output).toMatchObject({ url: "https://hooks.acme.io/ncj", secret: null });

    const moved = (await runAction("set_webhook", { url: "https://hooks.acme.io/v2" }, c.agent)).output;
    expect(moved).toMatchObject({ url: "https://hooks.acme.io/v2", secret: null });
    const off = (await runAction("set_webhook", { enabled: false }, c.agent)).output;
    expect(off).toMatchObject({ enabled: false, secret: null });

    const rotated = (await runAction("set_webhook", { rotate_secret: true }, c.agent)).output as { secret: string };
    expect(rotated.secret).toBe(await webhookSecret(KEY, c.co, 2));
    expect(all(db.raw, "SELECT action FROM audit_log WHERE action LIKE 'webhook.%' ORDER BY id").map((r) => r.action)).toEqual([
      "webhook.update",
      "webhook.update",
      "webhook.update",
      "webhook.rotate",
    ]);
    // Секрету немає ніде в базі.
    const dump = JSON.stringify(all(db.raw, "SELECT * FROM companies")) + JSON.stringify(all(db.raw, "SELECT * FROM audit_log"));
    expect(dump).not.toContain("whsec_");
  });

  it("refuses a private or local URL with a field error and keeps the old one", async () => {
    const c = await company();
    const err = await rejection(runAction("set_webhook", { url: "https://169.254.169.254/latest" }, c.agent));
    expect(err).toMatchObject({ code: "validation_failed", status: 422 });
    expect(err.details).toMatchObject({ fields: { url: expect.stringContaining("IP addresses") } });
    expect((await runAction("get_webhook", {}, c.agent)).output).toMatchObject({ url: "https://hooks.acme.io/ncj" });
    expect(await rejection(runAction("set_webhook", { enabled: true, url: "http://hooks.acme.io" }, c.agent))).toMatchObject({ status: 422 });
  });

  it("a member reads the webhook but cannot change it; companies never see each other's", async () => {
    const a = await company("Acme Labs");
    const b = await company("Beta Corp", null);
    const member = crypto.randomUUID();
    run(db.raw, "INSERT INTO users (id, email) VALUES (?, 'mia@acme.io')", member);
    run(db.raw, "INSERT INTO company_members (company_id, user_id, role, joined_at) VALUES (?, ?, 'member', datetime('now'))", a.co, member);
    const mia = await contextFor(db, { sessionUserId: member }, { now: NOW, env: { ...a.owner.env } });
    expect((await runAction("get_webhook", {}, mia)).output).toMatchObject({ url: "https://hooks.acme.io/ncj" });
    expect(await rejection(runAction("set_webhook", { enabled: false }, mia))).toMatchObject({ code: "forbidden", status: 403 });
    expect(await rejection(runAction("test_webhook", {}, mia))).toMatchObject({ code: "forbidden", status: 403 });
    expect((await runAction("get_webhook", {}, b.agent)).output).toMatchObject({ url: null, enabled: false });
  });
});

describe("test_webhook", () => {
  it("needs a URL first", async () => {
    const c = await company("Acme Labs", null);
    expect(await rejection(runAction("test_webhook", {}, c.agent))).toMatchObject({ code: "webhook_not_set", status: 409 });
  });

  it("sends a signed ping the receiver can verify, and logs it for the company", async () => {
    const c = await company();
    const res = (await runAction("test_webhook", {}, c.owner)).output;
    expect(res).toMatchObject({ delivered: true, status_code: 200, error: null });
    expect(hooks.hits).toHaveLength(1);
    const hit = hooks.hits[0];
    expect(hit.redirect).toBe("manual");
    expect(hit.headers).toMatchObject({
      "content-type": "application/json",
      "user-agent": "NextCryptoJob-Webhooks/1",
      "ncj-event-type": "ping",
      "ncj-delivery-attempt": "1",
    });
    expect(JSON.parse(hit.body)).toMatchObject({ type: "ping", api_version: "2026-09-12", company_id: c.co });
    expect(await verifySignature(hit.headers["ncj-signature"], hit.body, await webhookSecret(KEY, c.co, 1), NOW)).toBe(true);
    expect(await recentDeliveries(db.d1, c.co)).toMatchObject([{ kind: "test", outcome: "delivered", statusCode: 200 }]);
  });

  it("reports a redirect (not followed), an error status and a timeout", async () => {
    const c = await company();
    hooks.answer = () => 302;
    expect((await runAction("test_webhook", {}, c.agent)).output).toMatchObject({
      delivered: false,
      status_code: 302,
      error: "redirects are not followed (HTTP 302)",
    });
    expect(hooks.hits).toHaveLength(1);
    hooks.answer = () => 500;
    expect((await runAction("test_webhook", {}, c.agent)).output).toMatchObject({ delivered: false, status_code: 500, error: "HTTP 500" });
    hooks.answer = () => new DOMException("The operation timed out.", "TimeoutError");
    expect((await runAction("test_webhook", {}, c.agent)).output).toMatchObject({
      delivered: false,
      status_code: null,
      error: "timeout after 10 s",
    });
  });
});

describe("deliverWebhooks (cron)", () => {
  it("delivers intro.accepted with the contact, signed, and marks it delivered", async () => {
    const c = await company();
    const { introId } = await answered(c, "accept");
    expect(intro(introId)).toMatchObject({ webhook_state: "pending", webhook_event: "intro.accepted", webhook_attempts: 0 });

    expect(await deliverWebhooks(db.d1, { env, notifier, now: NOW })).toMatchObject({ attempted: 1, delivered: 1 });
    expect(intro(introId)).toMatchObject({ webhook_state: "delivered", webhook_attempts: 1, webhook_next_at: null, webhook_last_error: null });
    const hit = hooks.hits[0];
    expect(hit.headers).toMatchObject({ "ncj-event-type": "intro.accepted", "ncj-event-id": `evt_${introId}_accepted`, "ncj-delivery-attempt": "1" });
    const event = JSON.parse(hit.body);
    expect(event).toMatchObject({ id: `evt_${introId}_accepted`, type: "intro.accepted", api_version: "2026-09-12", company_id: c.co });
    const parsed = Intro.parse(event.data.intro);
    expect(parsed).toMatchObject({ intro_id: introId, status: "accepted", contact: { kind: "telegram", value: "@alice_eth" } });
    expect(await verifySignature(hit.headers["ncj-signature"], hit.body, await webhookSecret(KEY, c.co, 1), NOW)).toBe(true);

    // Повтор запуску нічого не шле.
    expect(await deliverWebhooks(db.d1, { env, notifier, now: at(HOUR) })).toMatchObject({ attempted: 0 });
    expect(hooks.hits).toHaveLength(1);
  });

  it("retries a failing receiver after 1 min, 5 min, 30 min, 2 h and 12 h, then gives up, raises the banner and tells the owner once", async () => {
    const c = await company();
    const { introId } = await answered(c, "decline");
    hooks.answer = () => 500;
    const tgBefore = net.tg.length;

    const schedule = [0, MIN, 5 * MIN, 30 * MIN, 2 * HOUR, 12 * HOUR];
    let t = 0;
    for (let i = 0; i < schedule.length; i++) {
      t += schedule[i];
      // Секунда до строку: ще не час.
      if (i > 0) expect(await deliverWebhooks(db.d1, { env, notifier, now: at(t - 1000) })).toMatchObject({ attempted: 0 });
      const res = await deliverWebhooks(db.d1, { env, notifier, now: at(t) });
      expect(res.attempted).toBe(1);
      expect(intro(introId).webhook_attempts).toBe(i + 1);
    }
    expect(hooks.hits.map((h) => h.headers["ncj-delivery-attempt"])).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(new Set(hooks.hits.map((h) => h.headers["ncj-event-id"]))).toEqual(new Set([`evt_${introId}_declined`]));
    expect(intro(introId)).toMatchObject({ webhook_state: "failed", webhook_attempts: MAX_ATTEMPTS, webhook_last_error: "HTTP 500", webhook_next_at: null });
    expect((await loadCompany(db.d1, c.co))?.webhookFailingSince).toBe("2026-09-13 02:36:00");
    const told = net.tg.slice(tgBefore).filter((m) => m.method === "sendMessage");
    expect(told.map((m) => String(m.payload.chat_id))).toEqual([c.ownerTelegram]);
    expect(String(told[0].payload.text)).toContain("Your webhook is failing");

    // Більше спроб немає; журнал доставок має всі шість.
    expect(await deliverWebhooks(db.d1, { env, notifier, now: at(t + 24 * HOUR) })).toMatchObject({ attempted: 0 });
    const log = await recentDeliveries(db.d1, c.co);
    expect(log.map((l) => l.outcome)).toEqual(["failed", "retrying", "retrying", "retrying", "retrying", "retrying"]);
    expect((await runAction("get_webhook", {}, c.agent)).output).toMatchObject({ failing_since: "2026-09-13T02:36:00Z" });

    // Нова подія й приймач знову відповідає: плашку знято, лист не повторюється.
    hooks.answer = () => 204;
    await answered(c, "accept", at(t + 25 * HOUR));
    expect(await deliverWebhooks(db.d1, { env, notifier, now: at(t + 25 * HOUR) })).toMatchObject({ delivered: 1 });
    expect((await loadCompany(db.d1, c.co))?.webhookFailingSince).toBeNull();
  });

  it("two overlapping runs send one request per attempt", async () => {
    const c = await company();
    await answered(c);
    await answered(c);
    const [one, two] = await Promise.all([
      deliverWebhooks(db.d1, { env, notifier, now: NOW }),
      deliverWebhooks(db.d1, { env, notifier, now: NOW }),
    ]);
    expect(one.delivered + two.delivered).toBe(2);
    expect(hooks.hits).toHaveLength(2);
    expect(new Set(hooks.hits.map((h) => h.headers["ncj-event-id"])).size).toBe(2);
  });

  it("drops the event when the webhook was switched off, and waits without the signing key", async () => {
    const c = await company();
    const { introId } = await answered(c);
    expect(await deliverWebhooks(db.d1, { env: { ...env, WEBHOOK_SIGNING_KEY: undefined }, notifier, now: NOW })).toMatchObject({ skipped: 1, attempted: 0 });
    expect(intro(introId)).toMatchObject({ webhook_state: "pending", webhook_attempts: 0 });

    await runAction("set_webhook", { enabled: false }, c.agent);
    expect(await deliverWebhooks(db.d1, { env, notifier, now: NOW })).toMatchObject({ dropped: 1, attempted: 0 });
    expect(intro(introId)).toMatchObject({ webhook_state: "none", webhook_next_at: null });
    expect(hooks.hits).toHaveLength(0);
  });

  it("signs with both secrets for 24 hours after a rotation, then only with the new one", async () => {
    const c = await company();
    await runAction("set_webhook", { rotate_secret: true }, { ...c.agent, now: NOW });
    const oldSecret = await webhookSecret(KEY, c.co, 1);
    const newSecret = await webhookSecret(KEY, c.co, 2);

    await answered(c, "accept", at(HOUR));
    await deliverWebhooks(db.d1, { env, notifier, now: at(HOUR) });
    const during = hooks.hits[0];
    expect(during.headers["ncj-signature"].match(/v1=/g)).toHaveLength(2);
    expect(await verifySignature(during.headers["ncj-signature"], during.body, oldSecret, at(HOUR))).toBe(true);
    expect(await verifySignature(during.headers["ncj-signature"], during.body, newSecret, at(HOUR))).toBe(true);

    await answered(c, "accept", at(25 * HOUR));
    await deliverWebhooks(db.d1, { env, notifier, now: at(25 * HOUR) });
    const after = hooks.hits[1];
    expect(after.headers["ncj-signature"].match(/v1=/g)).toHaveLength(1);
    expect(await verifySignature(after.headers["ncj-signature"], after.body, oldSecret, at(25 * HOUR))).toBe(false);
    expect(await verifySignature(after.headers["ncj-signature"], after.body, newSecret, at(25 * HOUR))).toBe(true);
  });

  it("keeps companies apart: each event goes to its own company's URL with its own secret, and each log shows only its own", async () => {
    const a = await company("Acme Labs", "https://hooks.acme.io/ncj");
    const b = await company("Beta Corp", "https://hooks.beta.io/ncj");
    const ia = await answered(a);
    const ib = await answered(b);
    await deliverWebhooks(db.d1, { env, notifier, now: NOW });

    const toA = hooks.hits.filter((h) => h.url.startsWith("https://hooks.acme.io/"));
    const toB = hooks.hits.filter((h) => h.url.startsWith("https://hooks.beta.io/"));
    expect(toA.map((h) => JSON.parse(h.body).data.intro.intro_id)).toEqual([ia.introId]);
    expect(toB.map((h) => JSON.parse(h.body).data.intro.intro_id)).toEqual([ib.introId]);
    const aSecret = await webhookSecret(KEY, a.co, 1);
    expect(await verifySignature(toA[0].headers["ncj-signature"], toA[0].body, aSecret, NOW)).toBe(true);
    expect(await verifySignature(toB[0].headers["ncj-signature"], toB[0].body, aSecret, NOW)).toBe(false);

    expect((await recentDeliveries(db.d1, a.co)).map((d) => d.introId)).toEqual([ia.introId]);
    expect((await recentDeliveries(db.d1, b.co)).map((d) => d.introId)).toEqual([ib.introId]);
  });

  it("refuses to post to a URL that became private in the database (checked again before every try)", async () => {
    const c = await company();
    const { introId } = await answered(c);
    run(db.raw, "UPDATE companies SET webhook_url = 'https://127.0.0.1/hook' WHERE id = ?", c.co);
    await deliverWebhooks(db.d1, { env, notifier, now: NOW });
    expect(hooks.hits).toHaveLength(0);
    expect(String(intro(introId).webhook_last_error)).toMatch(/^blocked: /);
  });
});
