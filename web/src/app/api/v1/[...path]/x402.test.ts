import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sqlTime } from "@/lib/time";
import {
  ORIGIN,
  paymentHeader,
  requiredFrom,
  rest,
  schemaErrors,
  settlementFrom,
  setupApi,
} from "@/test/api-fixtures";
import { addApiKey, addCompany, addScore, addSubscription, addUser, all, publishFormula } from "@/test/crm-fixtures";
import { addCandidate, MESSAGE, PAYER, type Network } from "@/test/intro-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { GET, POST } from "./route";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);

/**
 * Оплата x402 через REST (специфікація 7.4). Фасилітатор на заглушці fetch
 * (test/intro-fixtures.ts stubNetwork): /supported як у x402.org для Base Sepolia
 * і Solana devnet, /verify завжди «так», /settle «так» або insufficient_funds.
 * Лічильники net.verify і net.settle показують, скільки разів ми його питали.
 */

const post = (path: string, o: Parameters<typeof rest>[3] = {}) => rest(POST, "POST", path, o);
const get = (path: string, o: Parameters<typeof rest>[3] = {}) => rest(GET, "GET", path, o);

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

async function company(o: { subscribed?: boolean } = {}) {
  const co = addCompany(db.raw);
  if (o.subscribed ?? true) addSubscription(db.raw, co);
  const { id: keyId, key } = await addApiKey(db.raw, co);
  return { co, keyId, key };
}

function visibleEngineers(n: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    const id = addUser(db.raw, { telegram: `dev_${i}` });
    addScore(db.raw, id, "engineer", 60 + i);
    return id;
  });
}

const payments = () => all<{ status: string; action: string; channel: string; company_id: string | null }>(
  db.raw,
  "SELECT status, action, channel, company_id FROM x402_payments",
);
const usage = () => all(db.raw, "SELECT action, billing, status, payer FROM usage_events");

describe("guest search paid by x402", () => {
  it("without a payment the answer is 402 with the requirements for Base and Solana in the header and the body", async () => {
    const res = await post("/candidates/search", { body: { filters: { role: "engineer" } } });
    expect(res.status).toBe(402);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
    expect(requiredFrom(res)).toEqual(res.body);
    expect(res.body).toMatchObject({
      x402Version: 2,
      error: "PAYMENT-SIGNATURE header is required",
      resource: { url: `${ORIGIN}/api/v1/candidates/search`, mimeType: "application/json", serviceName: "NextCryptoJob" },
      extensions: { "payment-identifier": { info: { required: false } } },
    });
    expect(res.body.accepts.map((a: { network: string; amount: string; payTo: string }) => [a.network, a.amount, a.payTo])).toEqual([
      ["eip155:84532", "500000", "0x1111111111111111111111111111111111111111"],
      ["solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "500000", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"],
    ]);
    expect(schemaErrors("POST", "/candidates/search", res)).toEqual([]);
    expect(net.verify + net.settle).toBe(0);
    expect(payments()).toEqual([]);
  });

  it("a paid page comes back with PAYMENT-RESPONSE, is billed to the payer and written to the audit log", async () => {
    const ids = visibleEngineers(2);
    const required = requiredFrom(await post("/candidates/search", { body: {} }));
    const res = await post("/candidates/search", { body: {}, payment: paymentHeader(required) });
    expect(res.status).toBe(200);
    expect(res.body.data.map((d: { candidate_id: string }) => d.candidate_id)).toEqual([...ids].reverse());
    expect(JSON.stringify(res.body)).not.toMatch(/dev_\d|@example\.com/);
    expect(settlementFrom(res)).toMatchObject({ success: true, transaction: "0xtx1", network: "eip155:84532", payer: PAYER });
    expect(res.headers.get("RateLimit-Limit")).toBe("50");
    expect(schemaErrors("POST", "/candidates/search", res)).toEqual([]);
    expect(net.settle).toBe(1);
    expect(payments()).toEqual([{ status: "settled", action: "search_candidates", channel: "rest", company_id: null }]);
    expect(usage()).toEqual([{ action: "search_candidates", billing: "x402", status: 200, payer: PAYER }]);
    const [audit] = all<{ actor: string; meta_json: string }>(db.raw, "SELECT actor, meta_json FROM audit_log");
    expect(audit.actor).toMatch(/^x402_guest:pay_/);
    expect(JSON.parse(audit.meta_json)).toMatchObject({ channel: "rest", ids: [...ids].reverse() });
  });

  it("a failed settle is a 402 with PAYMENT-RESPONSE success:false and no data; nothing is counted", async () => {
    visibleEngineers(1);
    net.settleOk = false;
    const required = requiredFrom(await post("/candidates/search", { body: {} }));
    const res = await post("/candidates/search", { body: {}, payment: paymentHeader(required) });
    expect(res.status).toBe(402);
    expect(res.body).not.toHaveProperty("data");
    expect(settlementFrom(res)).toMatchObject({ success: false, errorReason: "insufficient_funds" });
    expect(payments().map((p) => p.status)).toEqual(["failed"]);
    expect(usage()).toEqual([]);
    expect(all(db.raw, "SELECT id FROM audit_log")).toEqual([]);
  });

  it("the same payment with the same payment-identifier gives the stored page again: no second charge, count or audit row", async () => {
    visibleEngineers(3);
    const required = requiredFrom(await post("/candidates/search", { body: { limit: 2 } }));
    const payment = paymentHeader(required, "search_retry_0123456789");
    const first = await post("/candidates/search", { body: { limit: 2 }, payment });
    expect(first.status).toBe(200);
    const again = await post("/candidates/search", { body: { limit: 2 }, payment });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(again.body.next_cursor).toBeTruthy();
    expect(settlementFrom(again)).toMatchObject({ success: true, transaction: settlementFrom(first).transaction });
    expect(net.settle).toBe(1);
    expect(usage()).toHaveLength(1);
    expect(all(db.raw, "SELECT id FROM audit_log")).toHaveLength(1);
  });

  it("a replay never hands out a candidate who hid after the payment", async () => {
    const [a, b] = visibleEngineers(2);
    const required = requiredFrom(await post("/candidates/search", { body: {} }));
    const payment = paymentHeader(required, "search_retry_hide_0123456789");
    expect((await post("/candidates/search", { body: {}, payment })).body.data).toHaveLength(2);
    db.raw.prepare("UPDATE users SET visible_to_companies = 0 WHERE id = ?").run(b);
    const again = await post("/candidates/search", { body: {}, payment });
    expect(again.body.data.map((d: { candidate_id: string }) => d.candidate_id)).toEqual([a]);
  });

  it("the same payment for another request, or without a payment-identifier, is 409 payment_reused and settles nothing", async () => {
    visibleEngineers(1);
    const required = requiredFrom(await post("/candidates/search", { body: {} }));
    const withId = paymentHeader(required, "search_retry_abcdefghijk");
    expect((await post("/candidates/search", { body: {}, payment: withId })).status).toBe(200);
    const otherInput = await post("/candidates/search", { body: { sort: "newest" }, payment: withId });
    expect(otherInput.status).toBe(409);
    expect(otherInput.body.error.code).toBe("payment_reused");

    const plain = paymentHeader(required);
    expect((await post("/candidates/search", { body: {}, payment: plain })).status).toBe(200);
    const reused = await post("/candidates/search", { body: {}, payment: plain });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("payment_reused");
    expect(schemaErrors("POST", "/candidates/search", reused)).toEqual([]);
    expect(net.settle).toBe(2);
    expect(usage()).toHaveLength(2);
  });

  it("a garbled payment header is a 402 invalid_payment, not an error page", async () => {
    const res = await post("/candidates/search", { body: {}, payment: "not base64 json" });
    expect(res.status).toBe(402);
    expect(res.body.error).toMatch(/^invalid_payment/);
    expect(net.verify).toBe(0);
  });
});

describe("companies without a subscription pay per request", () => {
  it("an intro to a hidden candidate is refused before any 402", async () => {
    const { key } = await company({ subscribed: false });
    const hidden = addCandidate(db, { visible: false });
    const res = await post("/intros", { key, body: { candidate_id: hidden.id, message: MESSAGE } });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("candidate_not_available");
  });

  it("an intro costs $5: 402, then the paid request creates it, and a replay returns it without asking the candidate again", async () => {
    const { co, key } = await company({ subscribed: false });
    const alice = addCandidate(db);
    const input = { candidate_id: alice.id, message: MESSAGE };
    const unpaid = await post("/intros", { key, body: input });
    expect(unpaid.status).toBe(402);
    expect(unpaid.body.accepts[0].amount).toBe("5000000");

    const payment = paymentHeader(requiredFrom(unpaid), "intro_retry_0123456789");
    const paid = await post("/intros", { key, body: input, payment });
    expect(paid.status).toBe(201);
    expect(paid.body).toMatchObject({ candidate_id: alice.id, status: "pending", requested_via: "rest", contact: null });
    expect(schemaErrors("POST", "/intros", paid)).toEqual([]);
    expect(settlementFrom(paid).success).toBe(true);
    expect(net.messagesTo(alice.telegramId!)).toHaveLength(1);

    const replay = await post("/intros", { key, body: input, payment });
    expect(replay.status).toBe(201);
    expect(replay.body.intro_id).toBe(paid.body.intro_id);
    expect(net.settle).toBe(1);
    expect(net.messagesTo(alice.telegramId!)).toHaveLength(1);
    expect(all(db.raw, "SELECT id FROM intros")).toHaveLength(1);
    expect(payments()).toEqual([{ status: "settled", action: "request_intro", channel: "rest", company_id: co }]);
  });

  it("a subscribed company never pays x402, even when it sends a payment", async () => {
    visibleEngineers(1);
    const { key } = await company();
    const res = await post("/candidates/search", { key, body: {}, payment: "e30" });
    expect(res.status).toBe(200);
    expect(res.headers.get("PAYMENT-RESPONSE")).toBeNull();
    expect(net.verify + net.settle).toBe(0);
    expect(usage()).toEqual([{ action: "search_candidates", billing: "included", status: 200, payer: null }]);
  });
});

describe("payments not configured", () => {
  it("without receiving addresses a paid action says what is missing and never reaches the facilitator", async () => {
    ({ db, net } = setupApi({ X402_PAY_TO_EVM: "", X402_PAY_TO_SOLANA: "" }));
    publishFormula(db.raw);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    visibleEngineers(1);
    const { key } = await company({ subscribed: false });
    const alice = addCandidate(db);

    const guest = await post("/candidates/search", { body: {} });
    expect(guest.status).toBe(401);
    expect(guest.body.error).toMatchObject({
      code: "not_configured",
      message: "Payments are not configured on this server (not configured: X402_PAY_TO_EVM, X402_PAY_TO_SOLANA).",
    });
    const withPayment = await post("/candidates/search", { body: {}, payment: "e30" });
    expect(withPayment.body.error.code).toBe("not_configured");
    const intro = await post("/intros", { key, body: { candidate_id: alice.id, message: MESSAGE } });
    expect(intro.status).toBe(503);
    expect(intro.body.error.code).toBe("not_configured");
    expect(schemaErrors("POST", "/intros", intro)).toEqual([]);

    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes("x402"))).toEqual([]);
    expect(payments()).toEqual([]);
    expect(all(db.raw, "SELECT id FROM intros")).toEqual([]);
    expect(net.messagesTo(alice.telegramId!)).toEqual([]);
  });

  it("on mainnet without CDP keys the message names CDP_API_KEY_ID", async () => {
    ({ db, net } = setupApi({ X402_NETWORK: "mainnet" }));
    const res = await post("/candidates/search", { body: {} });
    expect(res.body.error.message).toContain("not configured: CDP_API_KEY_ID, CDP_API_KEY_SECRET");
    expect(net.verify + net.settle).toBe(0);
  });
});

describe("USDC month by x402", () => {
  it("$100 buys 30 days of subscription access, a second month stacks after the first, a replay adds nothing", async () => {
    const { co, key } = await company({ subscribed: false });
    expect((await get("/me", { key })).body.access.mode).toBe("pay_per_request");

    const unpaid = await post("/billing/usdc-month", { key });
    expect(unpaid.status).toBe(402);
    expect(unpaid.body.accepts[0].amount).toBe("100000000");
    const payment = paymentHeader(requiredFrom(unpaid), "usdc_month_0123456789");
    const first = await post("/billing/usdc-month", { key, payment });
    expect(first.status).toBe(200);
    expect(schemaErrors("POST", "/billing/usdc-month", first)).toEqual([]);
    const days = (iso: string) => Math.round((Date.parse(iso) - Date.now()) / 86_400_000);
    expect(days(first.body.period_end)).toBe(30);
    expect((await get("/me", { key })).body.access).toMatchObject({ mode: "subscription", subscription_status: "active" });

    const replay = await post("/billing/usdc-month", { key, payment });
    expect(replay.body).toEqual(first.body);

    const second = await post("/billing/usdc-month", { key, payment: paymentHeader(requiredFrom(unpaid)) });
    expect(days(second.body.period_end)).toBe(60);
    expect(net.settle).toBe(2);
    expect(all(db.raw, "SELECT provider, status, last_x402_payment_id IS NOT NULL AS paid FROM subscriptions WHERE company_id = ?", co)).toEqual([
      { provider: "usdc", status: "active", paid: 1 },
      { provider: "usdc", status: "active", paid: 1 },
    ]);
  });

  it("needs a key: a guest cannot buy a month for nobody", async () => {
    const res = await post("/billing/usdc-month", { payment: "e30" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("key_required");
    expect(net.verify).toBe(0);
  });
});

describe("usage", () => {
  it("counts calls per day and action and the x402 spend of the company", async () => {
    visibleEngineers(1);
    const { key } = await company({ subscribed: false });
    const required = requiredFrom(await post("/candidates/search", { key, body: {} }));
    expect((await post("/candidates/search", { key, body: {}, payment: paymentHeader(required) })).status).toBe(200);
    await get("/pipeline", { key });
    const res = await get("/usage", { key });
    expect(res.status).toBe(200);
    expect(schemaErrors("GET", "/usage", res)).toEqual([]);
    const today = sqlTime(new Date()).slice(0, 10);
    expect(res.body.days).toEqual([
      { date: today, action: "list_pipeline", calls: 1, x402_usd: "0.00" },
      { date: today, action: "search_candidates", calls: 1, x402_usd: "0.50" },
    ]);
    expect(res.body.totals).toEqual({ calls: 2, x402_usd: "0.50" });
    const bad = await get("/usage?from=2026-09-30&to=2026-09-01", { key });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.fields).toHaveProperty("from");
  });
});
