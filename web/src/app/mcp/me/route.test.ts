import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readOnlyJobsDb } from "@/lib/jobs-db";
import { readBridge, bridgeRequest, stripBridge } from "@/lib/oauth/bridge";
import { BRIDGE_KEY_HEADER, BRIDGE_USER_HEADER, SCOPE } from "@/lib/oauth/config";
import { JOBS_VIEW_URI } from "@/lib/mcp-ui/jobs-view";
import { MCP_APP_MIME } from "@/lib/mcp-ui/app-shell";
import { ORIGIN, setupApi, type Json } from "@/test/api-fixtures";
import { addUser, run } from "@/test/crm-fixtures";
import { harness } from "@/test/harness";
import { jobsTestDb } from "@/test/jobs-db";
import type { TestDb } from "@/test/sqlite-d1";
import { POST } from "./route";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
// База вакансій: прив'язку підміняємо на рівні модуля, як і в Worker лише через jobsDb().
const jobsHolder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/jobs-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs-db")>()),
  jobsDb: () => jobsHolder.db,
}));

/**
 * Особистий MCP людини (/mcp/me) через справжній маршрут: людину дає лише міст від worker.ts
 * (заголовки + секрет), інструменти бачать лише її дані.
 */

const SECRET = "bridge-secret-0123456789abcdef0123456789";
let db: TestDb;
let jobs: TestDb;
let rpc = 0;

beforeEach(() => {
  ({ db } = setupApi());
  jobs = jobsTestDb();
  (harness.env as Record<string, unknown>).CONNECTOR_BRIDGE_SECRET = SECRET;
  jobsHolder.db = readOnlyJobsDb(jobs.d1);
});

afterEach(() => vi.restoreAllMocks());

function person(o: { done?: boolean; city?: string | null; remote?: string } = {}): string {
  const id = addUser(db.raw, { targetText: "Solidity engineer at a DeFi protocol", remoteMode: o.remote ?? "remote", city: o.city ?? null });
  run(db.raw, "UPDATE users SET onboarding_step = ? WHERE id = ?", (o.done ?? true) ? "done" : "place", id);
  return id;
}

function crawlJob(id: string) {
  run(
    jobs.raw,
    `INSERT INTO jobs_cache (id, url, company, company_key, title, location, remote, source, dedupe_key, fetched_at, first_seen_at)
     VALUES (?, ?, 'Acme', '', ?, 'Remote', 1, 'greenhouse:x', '', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`,
    id,
    `https://jobs.example.com/${id}`,
    `Engineer ${id}`,
  );
}

function sent(userId: string, digestId: string, refs: string[]) {
  run(db.raw, "INSERT INTO digest_runs (id, user_id, local_date, status, jobs, channel) VALUES (?, ?, '2026-11-09', 'sent', ?, 'email')", digestId, userId, refs.length);
  refs.forEach((ref, i) =>
    run(
      db.raw,
      `INSERT INTO sent (user_id, job_ref, source, digest_id, position, status, channel, why)
       VALUES (?, ?, 'nextrole', ?, ?, 'sent', 'email', ?)`,
      userId,
      ref,
      digestId,
      i + 1,
      `Why ${ref}`,
    ),
  );
}

async function call(userId: string | null, method: string, params: Record<string, unknown> = {}, o: { secret?: string; scope?: string } = {}) {
  let req = new Request(`${ORIGIN}/mcp/me`, {
    method: "POST",
    headers: {
      host: "nextcryptojob.xyz",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method, params }),
  });
  if (userId) req = bridgeRequest(req, o.secret ?? SECRET, { userId, scopes: [o.scope ?? SCOPE], clientId: "https://claude.ai/oauth/x" });
  const res = await POST(req);
  const text = await res.text();
  const data = text.includes("data: ") ? text.split("\n").find((l) => l.startsWith("data: "))!.slice(6) : text;
  return { status: res.status, body: data ? (JSON.parse(data) as Json) : null };
}

async function tool(userId: string, name: string, args: Record<string, unknown> = {}) {
  const res = await call(userId, "tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  return res.body.result as { isError?: boolean; structuredContent?: Json; content: { text: string }[] };
}

describe("who may call /mcp/me", () => {
  it("refuses a request without the bridge, with a wrong secret or without the scope", async () => {
    const id = person();
    expect((await call(null, "tools/list")).status).toBe(401);
    expect((await call(id, "tools/list", {}, { secret: "x".repeat(40) })).status).toBe(401);
    expect((await call(id, "tools/list", {}, { scope: "other" })).status).toBe(401);
  });

  it("refuses everyone when the Worker has no bridge secret", async () => {
    const id = person();
    (harness.env as Record<string, unknown>).CONNECTOR_BRIDGE_SECRET = undefined;
    expect((await call(id, "tools/list")).status).toBe(401);
  });

  it("stripBridge drops forged bridge headers from an outside request", () => {
    const forged = new Request(`${ORIGIN}/mcp/me`, { headers: { [BRIDGE_USER_HEADER]: "victim", [BRIDGE_KEY_HEADER]: SECRET, cookie: "a=b" } });
    const clean = stripBridge(forged);
    expect(clean.headers.get(BRIDGE_USER_HEADER)).toBeNull();
    expect(clean.headers.get(BRIDGE_KEY_HEADER)).toBeNull();
    expect(clean.headers.get("cookie")).toBe("a=b");
    expect(readBridge(clean, SECRET)).toBeNull();
  });

  it("the bridge drops the bearer token, so the site never sees it", () => {
    const req = bridgeRequest(new Request(`${ORIGIN}/mcp/me`, { headers: { authorization: "Bearer secret-token" } }), SECRET, { userId: "u1", scopes: [SCOPE] });
    expect(req.headers.get("authorization")).toBeNull();
    expect(readBridge(req, SECRET)).toEqual({ userId: "u1", scopes: [SCOPE], clientId: null });
  });
});

describe("tools/list for the connector directory", () => {
  it("lists five tools, each with a title and read or write hints; the job tools carry the card view", async () => {
    const res = await call(person(), "tools/list");
    const tools = res.body.result.tools as { name: string; title?: string; annotations?: Json; _meta?: Json }[];
    expect(tools.map((t) => t.name).sort()).toEqual(["get_my_brief", "get_my_matches", "rate_job", "search_jobs", "update_my_brief"]);
    for (const t of tools) {
      expect(t.title, t.name).toBeTruthy();
      expect(typeof t.annotations?.readOnlyHint, t.name).toBe("boolean");
      expect(t.annotations?.destructiveHint, t.name).toBe(false);
    }
    const ui = (n: string) => tools.find((t) => t.name === n)!._meta?.ui?.resourceUri;
    expect(ui("search_jobs")).toBe(JOBS_VIEW_URI);
    expect(ui("get_my_matches")).toBe(JOBS_VIEW_URI);
  });

  it("serves the card view as an MCP App resource with no outside script", async () => {
    const res = await call(person(), "resources/read", { uri: JOBS_VIEW_URI });
    const c = res.body.result.contents[0];
    expect(c.mimeType).toBe(MCP_APP_MIME);
    expect(c.text).toContain("ui/initialize");
    expect(c.text).not.toMatch(/<script[^>]+src=/);
  });
});

describe("the person's own data", () => {
  it("get_my_brief returns this person's brief only", async () => {
    const ada = person({ remote: "remote,city", city: "Lisbon" });
    person({ city: "Berlin", remote: "city" });
    const r = await tool(ada, "get_my_brief");
    expect(r.structuredContent).toMatchObject({ job_words: "Solidity engineer at a DeFi protocol", work: "both", city: "Lisbon", finished: true });
  });

  it("get_my_matches lists sent jobs with why, newest first, and nobody else's", async () => {
    const ada = person();
    const bob = person();
    crawlJob("a1");
    crawlJob("b1");
    sent(ada, "dg_a", ["nr:a1"]);
    sent(bob, "dg_b", ["nr:b1"]);
    const r = await tool(ada, "get_my_matches");
    expect(r.structuredContent.matches).toHaveLength(1);
    expect(r.structuredContent.matches[0]).toMatchObject({
      ref: "nr:a1",
      title: "Engineer a1",
      company: "Acme",
      url: "https://jobs.example.com/a1",
      why: "Why nr:a1",
      vote: null,
    });
  });

  it("update_my_brief changes only the given fields and checks the city", async () => {
    const ada = person({ remote: "remote" });
    const missingCity = await tool(ada, "update_my_brief", { work: "city" });
    expect(missingCity.isError).toBe(true);
    expect(missingCity.content[0].text).toContain("city");

    const r = await tool(ada, "update_my_brief", { work: "both", city: "Porto", salary_min: 90000, currency: "EUR" });
    expect(r.isError).toBeFalsy();
    const row = db.raw.prepare("SELECT target_text, remote_mode, city, salary_min, salary_currency FROM users WHERE id = ?").get(ada);
    expect(row).toEqual({
      target_text: "Solidity engineer at a DeFi protocol",
      remote_mode: "remote,city",
      city: "Porto",
      salary_min: 90000,
      salary_currency: "EUR",
    });
  });

  it("update_my_brief refuses before the brief is finished, and refuses an empty change", async () => {
    const r = await tool(person({ done: false }), "update_my_brief", { job_words: "Rust engineer" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("/welcome");
    const empty = await tool(person(), "update_my_brief", {});
    expect(empty.isError).toBe(true);
  });

  it("rate_job saves a vote only for the person's own matches", async () => {
    const ada = person();
    const bob = person();
    crawlJob("a1");
    crawlJob("b1");
    sent(ada, "dg_a", ["nr:a1"]);
    sent(bob, "dg_b", ["nr:b1"]);

    const foreign = await tool(ada, "rate_job", { ref: "nr:b1", vote: "down", reason: "low_pay" });
    expect(foreign.isError).toBe(true);
    const own = await tool(ada, "rate_job", { ref: "nr:a1", vote: "down", reason: "low_pay" });
    expect(own.isError).toBeFalsy();
    expect(db.raw.prepare("SELECT user_id, job_ref, vote, reason FROM job_feedback").all()).toEqual([
      { user_id: ada, job_ref: "nr:a1", vote: "down", reason: "low_pay" },
    ]);
    const after = await tool(ada, "get_my_matches");
    expect(after.structuredContent.matches[0].vote).toBe("down");
  });

  it("search_jobs works for the person like the public search", async () => {
    const r = await tool(person(), "search_jobs", { q: "engineer" });
    expect(r.isError).toBeFalsy();
    expect(Array.isArray(r.structuredContent.data)).toBe(true);
  });
});
