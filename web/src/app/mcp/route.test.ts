import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIONS } from "@/lib/crm/actions";
import { respondToIntro } from "@/lib/crm/intros";
import { callTool, evmPayment, mcp, rest, setupApi, type Json } from "@/test/api-fixtures";
import { addApiKey, addCompany, addScore, addSubscription, addUser, all, publishFormula } from "@/test/crm-fixtures";
import { addCandidate, BOT_TOKEN, MESSAGE, PAYER, type Network } from "@/test/intro-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { GET as restGet } from "../api/v1/[...path]/route";
import { POST } from "./route";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);

/**
 * MCP через справжній маршрут /mcp (streamable HTTP без стану, MCP SDK v2):
 * набір інструментів під актора, ключ, паритет з REST, оплата через
 * `_meta["x402/payment"]`, повтор, приватність і межі компаній.
 */

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

async function company(o: { subscribed?: boolean; name?: string } = {}) {
  const co = addCompany(db.raw, { name: o.name ?? "Acme Labs" });
  if (o.subscribed ?? true) addSubscription(db.raw, co);
  const { id: keyId, key } = await addApiKey(db.raw, co);
  return { co, keyId, key };
}

function engineer(score = 70): string {
  const id = addUser(db.raw, { telegram: "hidden_handle" });
  addScore(db.raw, id, "engineer", score);
  return id;
}

/** Вимога оплати з результату інструмента без платежу. */
async function requirement(name: string, args: Record<string, unknown>, key?: string) {
  const res = await callTool(POST, name, args, { key });
  expect(res.isError).toBe(true);
  return res.structuredContent;
}

describe("tools per actor", () => {
  it("without a key only search_jobs and search_candidates are listed", async () => {
    const res = await mcp(POST, "tools/list");
    expect(res.status).toBe(200);
    expect(res.body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["search_candidates", "search_jobs"]);
  });

  it("with a key all 28 tools are listed with the registry's description, schemas and hints", async () => {
    const { key } = await company();
    const res = await mcp(POST, "tools/list", {}, { key });
    const tools = res.body.result.tools as { name: string; description: string; inputSchema: Json; outputSchema: Json; annotations?: object }[];
    expect(tools.map((t) => t.name).sort()).toEqual(ACTIONS.map((a) => a.name).sort());
    for (const a of ACTIONS) {
      const t = tools.find((x) => x.name === a.name)!;
      expect({ name: t.name, description: t.description, annotations: t.annotations ?? {} }).toEqual({
        name: a.name,
        description: a.description,
        annotations: a.mcp.annotations,
      });
      expect(t.inputSchema.type).toBe("object");
      expect(t.outputSchema.type).toBe("object");
    }
    const search = tools.find((t) => t.name === "search_candidates")!;
    expect(Object.keys(search.inputSchema.properties).sort()).toEqual(["cursor", "filters", "limit", "sort"]);
    expect(search.inputSchema.additionalProperties).toBe(false);
  });

  it("a guest cannot call a tool that needs a key: it does not exist for them", async () => {
    const res = await mcp(POST, "tools/call", { name: "request_intro", arguments: { candidate_id: crypto.randomUUID(), message: MESSAGE } });
    expect(res.body.error).toMatchObject({ code: -32602, message: "Tool request_intro not found" });
  });

  it("a revoked or unknown key is an HTTP 401 with the REST error body", async () => {
    const { co } = await company();
    const { key: revoked } = await addApiKey(db.raw, co, { revoked: true });
    const res = await mcp(POST, "tools/list", {}, { key: revoked });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
    expect(res.body.error).toMatchObject({ code: "key_revoked" });
    const unknown = await mcp(POST, "tools/list", {}, { key: `ncj_live_${"z".repeat(43)}` });
    expect(unknown.body.error.code).toBe("invalid_api_key");
  });

  it("refuses a Host it does not serve (DNS rebinding)", async () => {
    const res = await mcp(POST, "tools/list", {}, { headers: { host: "evil.example" } });
    expect(res.status).toBe(403);
  });
});

describe("same actions as REST", () => {
  it("structuredContent of get_account is the REST body of GET /me, byte for byte", async () => {
    const { key } = await company();
    const viaMcp = await callTool(POST, "get_account", {}, { key });
    const viaRest = await rest(restGet, "GET", "/me", { key });
    expect(viaMcp.isError).toBeUndefined();
    expect(JSON.stringify(viaMcp.structuredContent)).toBe(JSON.stringify(viaRest.body));
    expect(JSON.parse(viaMcp.content[0].text)).toEqual(viaRest.body);
  });

  it("invalid input is the same validation_failed error as REST, with the field", async () => {
    const { key } = await company();
    const res = await callTool(POST, "get_candidate", { candidate_id: "not-a-uuid" }, { key });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error).toMatchObject({ code: "validation_failed", details: { fields: { candidate_id: expect.any(String) } } });
  });

  it("a metered tool reports its daily quota in _meta ncj/quota and writes the audit log with channel mcp", async () => {
    engineer();
    const { key } = await company();
    const res = await callTool(POST, "search_candidates", { filters: { role: "engineer" } }, { key });
    expect(res.structuredContent.data).toHaveLength(1);
    expect(res._meta?.["ncj/quota"]).toEqual({ limit: 300, remaining: 299, reset_seconds: expect.any(Number) });
    const [row] = all<{ meta_json: string }>(db.raw, "SELECT meta_json FROM audit_log WHERE action = 'candidate.search'");
    expect(JSON.parse(row.meta_json).channel).toBe("mcp");
  });

  it("without a subscription all 28 tools stay listed; a tool that is not live yet answers not_implemented", async () => {
    const { key } = await company({ subscribed: false });
    const list = await mcp(POST, "tools/list", {}, { key });
    expect(list.body.result.tools).toHaveLength(28);
    const res = await callTool(POST, "get_account", {}, { key });
    expect(res.structuredContent.access.mode).toBe("pay_per_request");
    const pending = await callTool(POST, "post_job", { title: "Solidity engineer", roles: ["engineer"], work_mode: ["remote"] }, { key });
    expect(pending.structuredContent.error.code).toBe("not_implemented");
  });
});

describe("x402 through _meta", () => {
  it("a guest search: payment required as a tool result, then the paid page with x402/payment-response", async () => {
    const id = engineer();
    const required = await requirement("search_candidates", {});
    expect(required).toMatchObject({
      x402Version: 2,
      error: "Payment required",
      resource: { url: "mcp://tool/search_candidates" },
    });
    expect(required.accepts.map((a: { amount: string }) => a.amount)).toEqual(["500000", "500000"]);

    const paid = await callTool(POST, "search_candidates", {}, { payment: evmPayment(required) });
    expect(paid.isError).toBeUndefined();
    expect(paid.structuredContent.data.map((d: { candidate_id: string }) => d.candidate_id)).toEqual([id]);
    expect(JSON.stringify(paid.structuredContent)).not.toContain("hidden_handle");
    expect(paid._meta?.["x402/payment-response"]).toMatchObject({ success: true, transaction: "0xtx1", payer: PAYER });
    expect(net.settle).toBe(1);
    expect(all(db.raw, "SELECT channel, status FROM x402_payments")).toEqual([{ channel: "mcp", status: "settled" }]);
  });

  it("a failed settle gives the payment-required result again, with success:false and no data", async () => {
    engineer();
    net.settleOk = false;
    const required = await requirement("search_candidates", {});
    const res = await callTool(POST, "search_candidates", {}, { payment: evmPayment(required) });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).not.toHaveProperty("data");
    expect(res._meta?.["x402/payment-response"]).toMatchObject({ success: false, errorReason: "insufficient_funds" });
    expect(all(db.raw, "SELECT id FROM usage_events")).toEqual([]);
  });

  it("a paid intro for a company without a subscription, and its replay, notify the candidate once", async () => {
    const { key } = await company({ subscribed: false });
    const alice = addCandidate(db);
    const args = { candidate_id: alice.id, message: MESSAGE };
    const required = await requirement("request_intro", args, key);
    expect(required.accepts[0].amount).toBe("5000000");
    const payment = evmPayment(required, "mcp_intro_retry_0123456789");
    const first = await callTool(POST, "request_intro", args, { key, payment });
    expect(first.structuredContent).toMatchObject({ status: "pending", requested_via: "mcp", contact: null });
    const again = await callTool(POST, "request_intro", args, { key, payment });
    expect(again.structuredContent.intro_id).toBe(first.structuredContent.intro_id);
    expect(net.settle).toBe(1);
    expect(net.messagesTo(alice.telegramId!)).toHaveLength(1);
  });

  it("without x402 settings the tool says payments are not configured and asks no facilitator", async () => {
    ({ db, net } = setupApi({ X402_PAY_TO_EVM: "", X402_PAY_TO_SOLANA: "" }));
    const res = await callTool(POST, "search_candidates", {});
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error).toMatchObject({ code: "not_configured" });
    expect(res.structuredContent.error.message).toContain("not configured: X402_PAY_TO_EVM");
    expect(net.verify + net.settle).toBe(0);
  });
});

describe("privacy and tenant isolation", () => {
  it("no contact before the candidate accepts; after, only the asking company sees it", async () => {
    const a = await company({ name: "Acme Labs" });
    const b = await company({ name: "Other Co" });
    const alice = addCandidate(db);
    const intro = await callTool(POST, "request_intro", { candidate_id: alice.id, message: MESSAGE }, { key: a.key });
    const introId = intro.structuredContent.intro_id as string;
    const profile = await callTool(POST, "get_candidate", { candidate_id: alice.id }, { key: a.key });
    expect(JSON.stringify([intro, profile])).not.toMatch(/alice_eth|@gmail/);

    await respondToIntro(db.d1, {
      introId,
      userId: alice.id,
      decision: "accept",
      via: "web",
      notifier: { botToken: BOT_TOKEN, mailer: null, origin: "https://nextcryptojob.xyz" },
    });
    const status = await callTool(POST, "intro_status", { intro_id: introId }, { key: a.key });
    expect(status.structuredContent.contact).toMatchObject({ kind: "telegram", value: "@alice_eth" });

    const foreign = await callTool(POST, "intro_status", { intro_id: introId }, { key: b.key });
    expect(foreign.structuredContent.error.code).toBe("not_found");
    const theirView = await callTool(POST, "get_candidate", { candidate_id: alice.id }, { key: b.key });
    expect(theirView.structuredContent).toMatchObject({ contact: null, intro: null });
    const theirPipeline = await callTool(POST, "list_pipeline", {}, { key: b.key });
    expect(theirPipeline.structuredContent.data).toEqual([]);
  });
});
