import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readX402Config } from "@/lib/x402/config";
import { clearResourceServerCache, createPaymentGate, type PaymentRequirementsSet } from "@/lib/x402/server";
import {
  addApiKey,
  addCompany,
  addScore,
  addUsage,
  addUser,
  all,
  contextFor,
  crmDb,
  publishFormula,
} from "@/test/crm-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import {
  commit,
  PaymentRequired,
  prepareAction,
  release,
  reserve,
  run,
  runAction,
  type PreparedAction,
  type Reservation,
} from "./actions";
import type { ActionContext } from "./context";
import { ActionError } from "./types";

/**
 * Кроки реєстру разом зі шлюзом x402, як їх поєднають REST (T9) і MCP (T10):
 * prepareAction → reserve (validate шлюзу, квоти до settle) → run (effect) →
 * commit після вдалого settle або release після невдалого.
 */

const PAY_TO = { X402_PAY_TO_EVM: "0x1111111111111111111111111111111111111111", X402_PAY_TO_SOLANA: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" };
const PAYER = "0x2222222222222222222222222222222222222222";
const RESOURCE = { url: "https://nextcryptojob.xyz/api/v1/candidates/search", description: "NextCryptoJob candidate search" };
const NOON = new Date("2026-09-12T12:00:00Z");

/** Фасилітатор на заглушці fetch: verify завжди так; settle як скаже тест. */
function fakeFacilitator() {
  const state = { verify: 0, settle: 0, settleOk: true };
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/supported")) {
      return Response.json({
        kinds: [
          { x402Version: 2, scheme: "exact", network: "eip155:84532" },
          { x402Version: 2, scheme: "exact", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", extra: { feePayer: "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5" } },
        ],
        extensions: [],
        signers: {},
      });
    }
    const body = JSON.parse(String(init?.body));
    if (url.endsWith("/verify")) {
      state.verify++;
      return Response.json({ isValid: true, payer: PAYER });
    }
    state.settle++;
    return state.settleOk
      ? Response.json({ success: true, transaction: `0xtx${state.settle}`, network: body.paymentRequirements.network, payer: PAYER })
      : Response.json({ success: false, errorReason: "insufficient_funds", transaction: "", network: body.paymentRequirements.network });
  });
  return state;
}

let nonce = 0;
function evmPayment(set: PaymentRequirementsSet): PaymentPayload {
  nonce++;
  return {
    x402Version: 2,
    resource: set.resource,
    accepted: set.accepts[0],
    payload: {
      signature: `0x${nonce.toString(16).padStart(130, "0")}`,
      authorization: {
        from: PAYER,
        to: set.accepts[0].payTo,
        value: set.accepts[0].amount,
        validAfter: "0",
        validBefore: "9999999999",
        nonce: `0x${nonce.toString(16).padStart(64, "0")}`,
      },
    },
  };
}

let db: TestDb;
let facilitator: ReturnType<typeof fakeFacilitator>;

beforeEach(() => {
  clearResourceServerCache();
  db = crmDb();
  publishFormula(db.raw);
  facilitator = fakeFacilitator();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Платний виклик через шлюз так, як це робитиме маршрут. */
async function paidCall(prepared: PreparedAction) {
  if (!prepared.payment) throw new Error("expected a paid action");
  const gate = createPaymentGate({ db: db.d1, config: readX402Config(PAY_TO, "development") });
  const set = await gate.requirementsFor(prepared.payment.action, RESOURCE);
  let reservation: Reservation | undefined;
  const paid = gate.withPayment<Awaited<ReturnType<typeof run>>, ActionError>(prepared.payment.action, prepared.payment.settle, {
    validate: async (p) => {
      try {
        reservation = await reserve(prepared, { id: p.paymentId, payer: p.payer });
      } catch (e) {
        if (e instanceof ActionError) return e;
        throw e;
      }
    },
    effect: () => run(prepared),
  });
  const out = await paid({
    payment: encodePaymentSignatureHeader(evmPayment(set)),
    input: prepared.input,
    resource: RESOURCE,
    context: { channel: "rest", companyId: prepared.ctx.company?.id ?? null },
  });
  if (out.kind === "ok") return { out, result: await commit(reservation!, out.value) };
  if (reservation) await release(reservation, 402);
  return { out, result: null };
}

const usage = () => all(db.raw, "SELECT action, billing, status, payer, x402_payment_id FROM usage_events");
const audit = () => all(db.raw, "SELECT actor, action FROM audit_log");

describe("paid search (settle before response)", () => {
  it("a failed settle leaves no usage row and no audit row, and gives no data", async () => {
    addScore(db.raw, addUser(db.raw), "engineer", 70);
    facilitator.settleOk = false;
    const prepared = prepareAction("search_candidates", {}, await contextFor(db, { hasPayment: true }, { now: NOON }));
    const { out, result } = await paidCall(prepared);
    expect(out.kind).toBe("payment_required");
    expect(result).toBeNull();
    expect(facilitator.settle).toBe(1);
    expect(usage()).toEqual([]);
    expect(audit()).toEqual([]);
    expect(all(db.raw, "SELECT status FROM x402_payments")).toEqual([{ status: "failed" }]);
  });

  it("a settled search is counted for the payer and written to the audit log with the payment id", async () => {
    addScore(db.raw, addUser(db.raw), "engineer", 70);
    const prepared = prepareAction("search_candidates", {}, await contextFor(db, { hasPayment: true }, { now: NOON }));
    const { out, result } = await paidCall(prepared);
    expect(out.kind).toBe("ok");
    expect((result!.output as { data: unknown[] }).data).toHaveLength(1);
    expect(result!.headers["RateLimit-Remaining"]).toBe("49");
    const [pay] = all<{ id: string }>(db.raw, "SELECT id FROM x402_payments WHERE status = 'settled'");
    expect(usage()).toEqual([{ action: "search_candidates", billing: "x402", status: 200, payer: PAYER, x402_payment_id: pay.id }]);
    expect(audit()).toEqual([{ actor: `x402_guest:${pay.id}`, action: "candidate.search" }]);
  });

  it("a guest over the daily quota gets 429 before any settle", async () => {
    addUsage(db.raw, 50, { payer: PAYER, action: "search_candidates", at: "2026-09-12 01:00:00" });
    const prepared = prepareAction("search_candidates", {}, await contextFor(db, { hasPayment: true }, { now: NOON }));
    const { out } = await paidCall(prepared);
    expect(out).toMatchObject({ kind: "rejected", error: { code: "daily_quota_exceeded", status: 429 } });
    expect(facilitator.settle).toBe(0);
    expect(usage()).toHaveLength(50);
  });
});

describe("paid intro (settle before effect)", () => {
  it("a company without a subscription over its daily intro quota gets 429 before any settle", async () => {
    const co = addCompany(db.raw);
    const { key } = await addApiKey(db.raw, co);
    addUsage(db.raw, 10, { companyId: co, action: "request_intro", at: "2026-09-12 09:00:00" });
    const candidate = addUser(db.raw);
    const ctx: ActionContext = await contextFor(db, { authorization: `Bearer ${key}` }, { now: NOON });
    const prepared = prepareAction("request_intro", { candidate_id: candidate, message: "We would like to talk about a Solidity role." }, ctx);
    expect(prepared.payment).toMatchObject({ action: "request_intro", usd: "5.00", settle: "before_effect" });

    const { out } = await paidCall(prepared);
    expect(out).toMatchObject({ kind: "rejected", error: { code: "daily_quota_exceeded", status: 429 } });
    expect(facilitator.verify).toBe(1);
    expect(facilitator.settle).toBe(0);
    expect(all(db.raw, "SELECT id FROM intros")).toEqual([]);
    expect(usage()).toHaveLength(10);
    // Бронь платежу знято: той самий підписаний платіж можна повторити пізніше.
    expect(all(db.raw, "SELECT id FROM x402_payments")).toEqual([]);
  });
});

describe("not implemented actions", () => {
  it("answer 501 not_implemented before asking for any payment", async () => {
    const co = addCompany(db.raw);
    const { key } = await addApiKey(db.raw, co); // без підписки: місяць USDC платний
    const ctx = await contextFor(db, { authorization: `Bearer ${key}` });
    const call = runAction("buy_usdc_month", {}, ctx);
    await expect(call).rejects.toMatchObject({ code: "not_implemented", status: 501 });
    await expect(call).rejects.not.toBeInstanceOf(PaymentRequired);
    // Навіть з хибним входом: спершу 501.
    expect(() => prepareAction("post_job", { nonsense: true }, ctx)).toThrow(expect.objectContaining({ code: "not_implemented" }));
    expect(facilitator.verify + facilitator.settle).toBe(0);
  });

  it("unpaid steps write nothing until commit", async () => {
    const co = addCompany(db.raw);
    const { key } = await addApiKey(db.raw, co);
    addScore(db.raw, addUser(db.raw), "engineer", 70);
    const ctx = await contextFor(db, { authorization: `Bearer ${key}` }, { now: NOON });
    const prepared = prepareAction("get_account", {}, ctx);
    const reservation = await reserve(prepared);
    const result = await run(prepared);
    expect(usage()).toEqual([]);
    expect(audit()).toEqual([]);
    await commit(reservation, result);
    expect(usage()).toEqual([{ action: "get_account", billing: "free", status: 200, payer: null, x402_payment_id: null }]);
  });
});
