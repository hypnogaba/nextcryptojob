import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { readX402Config, type X402Config } from "./config";
import {
  clearResourceServerCache,
  createPaymentGate,
  mcpPaymentRequired,
  paymentResponseMeta,
  X402Error,
  type PaymentRequirementsSet,
} from "./server";
import { createTestDb, type TestDb } from "./test-db";

const EVM = "0x1111111111111111111111111111111111111111";
const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const FEE_PAYER = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
const PAYER = "0x2222222222222222222222222222222222222222";
const PAY_TO = { X402_PAY_TO_EVM: EVM, X402_PAY_TO_SOLANA: SOL };
/** Справжній ключ Ed25519 (base64 seed+public), щоб CDP-клієнт підписував JWT, як у проді. */
function ed25519Secret(): string {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const d = Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url");
  const x = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  return Buffer.concat([d, x]).toString("base64");
}
const CDP_ENV = { ...PAY_TO, CDP_API_KEY_ID: "key-id", CDP_API_KEY_SECRET: ed25519Secret() };
const SEARCH = { url: "https://nextcryptojob.xyz/api/v1/candidates/search", description: "NextCryptoJob candidate search, one page of up to 20 results" };

// ---------------------------------------------------------------------------
// Фасилітатор на заглушці fetch: відповідає як x402.org/CDP і записує, що його питали.

type Step = { op: "verify" | "settle"; body: { paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements } };

function fakeFacilitator() {
  const state = {
    calls: [] as Step[],
    supportedCalls: 0,
    verify: (): Response => Response.json({ isValid: true, payer: PAYER }),
    settle: (body: Step["body"]): Response =>
      Response.json({ success: true, transaction: `0xtx${state.calls.filter((c) => c.op === "settle").length}`, network: body.paymentRequirements.network, payer: PAYER }),
    onCall: (_op: Step["op"]) => {},
  };
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/supported")) {
      state.supportedCalls++;
      return Response.json({
        kinds: [
          { x402Version: 2, scheme: "exact", network: "eip155:8453" },
          { x402Version: 2, scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", extra: { feePayer: FEE_PAYER } },
          { x402Version: 2, scheme: "exact", network: "eip155:84532" },
          { x402Version: 2, scheme: "exact", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", extra: { feePayer: FEE_PAYER } },
        ],
        extensions: [],
        signers: {},
      });
    }
    const op = url.endsWith("/verify") ? "verify" : "settle";
    const body = JSON.parse(String(init?.body));
    state.calls.push({ op, body });
    state.onCall(op);
    return op === "verify" ? state.verify() : state.settle(body);
  });
  return state;
}

let nonce = 0;
/** Підписаний (для заглушки) платіж EVM за першою вимогою з набору. */
function evmPayment(set: PaymentRequirementsSet, extensions?: Record<string, unknown>, index = 0): PaymentPayload {
  nonce++;
  return {
    x402Version: 2,
    resource: set.resource,
    accepted: set.accepts[index],
    payload: {
      signature: `0x${nonce.toString(16).padStart(130, "0")}`,
      authorization: {
        from: PAYER,
        to: set.accepts[index].payTo,
        value: set.accepts[index].amount,
        validAfter: "0",
        validBefore: "9999999999",
        nonce: `0x${nonce.toString(16).padStart(64, "0")}`,
      },
    },
    ...(extensions ? { extensions } : {}),
  };
}

function withId(id: string) {
  return { "payment-identifier": { info: { required: false, id } } };
}

let t: TestDb;
let facilitator: ReturnType<typeof fakeFacilitator>;
const devConfig = () => readX402Config(PAY_TO, "development");

function rows() {
  return t.sqlite.prepare("SELECT * FROM x402_payments ORDER BY rowid").all() as Record<string, unknown>[];
}

beforeEach(() => {
  clearResourceServerCache();
  t = createTestDb();
  facilitator = fakeFacilitator();
});

afterEach(() => {
  t.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe("requirementsFor", () => {
  it.each<[string, X402Config, string[], string[]]>([
    [
      "mainnet",
      readX402Config(CDP_ENV, "production"),
      ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"],
      ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
    ],
    [
      "testnet",
      readX402Config(PAY_TO, "development"),
      ["eip155:84532", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"],
      ["0x036CbD53842c5426634e7929541eC2318f3dCF7e", "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"],
    ],
  ])("%s: Base and Solana at the same price for every paid action", async (_mode, config, networks, assets) => {
    const gate = createPaymentGate({ db: t.db, config });
    for (const [action, amount] of [
      ["search_candidates", "500000"],
      ["request_intro", "5000000"],
      ["buy_usdc_month", "100000000"],
    ] as const) {
      const set = await gate.requirementsFor(action, SEARCH).catch((e: X402Error) => {
        throw new Error(JSON.stringify(e.gate));
      });
      expect(set.accepts.map((a) => a.network)).toEqual(networks);
      expect(set.accepts.map((a) => a.asset)).toEqual(assets);
      expect(set.accepts.map((a) => a.amount)).toEqual([amount, amount]);
      expect(set.accepts.map((a) => a.payTo)).toEqual([EVM, SOL]);
      expect(set.accepts.every((a) => a.scheme === "exact" && a.maxTimeoutSeconds === 60)).toBe(true);
    }
    const set = await gate.requirementsFor("search_candidates", SEARCH);
    expect(set.accepts[0].extra).toEqual(_mode === "mainnet" ? { name: "USD Coin", version: "2" } : { name: "USDC", version: "2" });
    // feePayer для Solana бере фасилітатор із /supported.
    expect(set.accepts[1].extra).toEqual({ feePayer: FEE_PAYER });
  });

  it("asks the facilitator for /supported once per isolate, not on every request", async () => {
    const config = devConfig();
    await createPaymentGate({ db: t.db, config }).requirementsFor("search_candidates", SEARCH);
    await createPaymentGate({ db: t.db, config }).requirementsFor("request_intro", SEARCH);
    expect(facilitator.supportedCalls).toBe(1);
  });

  it("an unreachable facilitator gives a retryable error and is not cached", async () => {
    vi.stubGlobal("fetch", async () => new Response("down", { status: 500 }));
    const gate = createPaymentGate({ db: t.db, config: devConfig() });
    const failure = await gate.requirementsFor("search_candidates", SEARCH).catch((e) => e);
    expect(failure).toBeInstanceOf(X402Error);
    expect(failure.gate).toMatchObject({ status: 503, code: "internal" });
    // Причина від фасилітатора видна, а не лише «не вдалося ініціалізувати».
    expect(failure.gate.details.reason).toContain("getSupported failed (500)");

    facilitator = fakeFacilitator();
    await expect(gate.requirementsFor("search_candidates", SEARCH)).resolves.toMatchObject({ action: "search_candidates" });
  });
});

describe("paymentRequired", () => {
  it("answers 402 with no-store and a base64 PAYMENT-REQUIRED header equal to the body", async () => {
    const gate = createPaymentGate({ db: t.db, config: devConfig() });
    const set = await gate.requirementsFor("search_candidates", SEARCH);
    const res = await gate.paymentRequired(set);

    expect(res.status).toBe(402);
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(res.headers["PAYMENT-RESPONSE"]).toBeUndefined();
    expect(decodePaymentRequiredHeader(res.headers["PAYMENT-REQUIRED"])).toEqual(JSON.parse(JSON.stringify(res.body)));
    expect(res.body).toMatchObject({
      x402Version: 2,
      error: "PAYMENT-SIGNATURE header is required",
      resource: { ...SEARCH, mimeType: "application/json", serviceName: "NextCryptoJob" },
      accepts: set.accepts,
      extensions: { "payment-identifier": { info: { required: false } } },
    });
  });

  it("wraps into an MCP tool error with the same object", async () => {
    const gate = createPaymentGate({ db: t.db, config: devConfig() });
    const set = await gate.requirementsFor("search_candidates", { url: "mcp://tool/search_candidates", description: "search" });
    const { body } = await gate.paymentRequired(set, { error: "Payment required" });
    const result = mcpPaymentRequired(body);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBe(body);
    expect(JSON.parse(result.content[0].text)).toEqual(JSON.parse(JSON.stringify(body)));
    expect(result).not.toHaveProperty("_meta");
  });
});

// ---------------------------------------------------------------------------

describe("withPayment", () => {
  function search(gate = createPaymentGate({ db: t.db, config: devConfig() })) {
    const effect = vi.fn(async () => {
      facilitator.calls.push({ op: "effect" as never, body: undefined as never });
      return { results: ["cand-1", "cand-2"] };
    });
    return { gate, effect, run: gate.withPayment("search_candidates", "before_response", { effect }) };
  }

  async function freshSet() {
    return createPaymentGate({ db: t.db, config: devConfig() }).requirementsFor("search_candidates", SEARCH);
  }

  it("without a payment answers 402 and runs nothing", async () => {
    const { run, effect } = search();
    const rest = await run({ payment: undefined, resource: SEARCH, context: { channel: "rest" } });
    const mcp = await run({ payment: null, resource: SEARCH, context: { channel: "mcp" } });
    expect(rest).toMatchObject({ kind: "payment_required", response: { status: 402, body: { error: "PAYMENT-SIGNATURE header is required" } } });
    expect(mcp).toMatchObject({ kind: "payment_required", response: { body: { error: "Payment required" } } });
    expect(effect).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
  });

  it("before_response: computes, then settles, then returns, with PAYMENT-RESPONSE data", async () => {
    const { run, effect } = search();
    const payment = evmPayment(await freshSet());
    const out = await run({ payment: encodePaymentSignatureHeader(payment), resource: SEARCH, context: { channel: "rest", requestId: "req_1" } });

    if (out.kind !== "ok") throw new Error(JSON.stringify(out));
    expect(out.value).toEqual({ results: ["cand-1", "cand-2"] });
    expect(effect).toHaveBeenCalledOnce();
    expect(facilitator.calls.map((c) => c.op)).toEqual(["verify", "effect", "settle"]);
    expect(out.settlement).toMatchObject({ success: true, transaction: "0xtx1", network: "eip155:84532" });

    const [row] = rows();
    expect(row).toMatchObject({
      id: out.payment.paymentId,
      status: "settled",
      tx: "0xtx1",
      payer: PAYER,
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      pay_to: EVM,
      amount_atomic: "500000",
      amount_usd_cents: 50,
      action: "search_candidates",
      channel: "rest",
      facilitator: "x402org",
      request_id: "req_1",
    });
    expect(row.settled_at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    expect(out.payment.paymentId).toMatch(/^pay_[0-9A-Za-z]{20}$/);
    expect(paymentResponseMeta(out.settlement)["x402/payment-response"]).toMatchObject({ success: true, transaction: "0xtx1" });
  });

  it("before_effect: runs the effect only after a successful settle", async () => {
    const gate = createPaymentGate({ db: t.db, config: devConfig() });
    const order: string[] = [];
    facilitator.onCall = (op) => order.push(op);
    const run = gate.withPayment("request_intro", "before_effect", {
      validate: async () => {
        order.push("validate");
      },
      effect: async () => {
        order.push("effect");
        return { intro_id: "int_1" };
      },
    });
    const set = await gate.requirementsFor("request_intro", SEARCH);
    const out = await run({ payment: evmPayment(set), resource: SEARCH, context: { channel: "mcp" } });

    expect(out.kind).toBe("ok");
    expect(order).toEqual(["verify", "validate", "settle", "effect"]);
    expect(rows()[0]).toMatchObject({ action: "request_intro", amount_atomic: "5000000", amount_usd_cents: 500, channel: "mcp" });
  });

  it("accepts the MCP payment object on Solana as well as the base64 header", async () => {
    const { run } = search();
    const set = await freshSet();
    const solana: PaymentPayload = { x402Version: 2, accepted: set.accepts[1], payload: { transaction: "AQAB-solana-tx" } };
    facilitator.settle = () => Response.json({ success: true, transaction: "5solSig", network: set.accepts[1].network });
    const out = await run({ payment: solana, resource: SEARCH, context: { channel: "mcp" } });
    expect(out).toMatchObject({ kind: "ok", settlement: { transaction: "5solSig" } });
    expect(rows()[0]).toMatchObject({ network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", pay_to: SOL, status: "settled" });
  });

  it("the same payment twice: second is payment_reused, verified and settled only once", async () => {
    const { run, effect } = search();
    const header = encodePaymentSignatureHeader(evmPayment(await freshSet()));
    const first = await run({ payment: header, resource: SEARCH, context: { channel: "rest" } });
    const second = await run({ payment: header, resource: SEARCH, context: { channel: "rest" } });

    expect(first.kind).toBe("ok");
    expect(second).toMatchObject({ kind: "error", error: { status: 409, code: "payment_reused" } });
    expect(effect).toHaveBeenCalledOnce();
    expect(facilitator.calls.filter((c) => c.op === "verify")).toHaveLength(1);
    expect(facilitator.calls.filter((c) => c.op === "settle")).toHaveLength(1);
    expect(rows()).toHaveLength(1);
  });

  it("a changed payment-identifier or resource does not make an old signature new", async () => {
    const { run, effect } = search();
    const payment = evmPayment(await freshSet(), withId("pay_first_attempt_0001"));
    await run({ payment, resource: SEARCH, context: { channel: "rest" } });
    const disguised = { ...payment, resource: { url: "https://elsewhere.example" }, extensions: withId("pay_second_attempt_002") };
    const out = await run({ payment: disguised, resource: SEARCH, context: { channel: "rest" } });
    expect(out).toMatchObject({ kind: "error", error: { code: "payment_reused" } });
    expect(effect).toHaveBeenCalledOnce();
  });

  it("same payment-identifier and same payment: returns the stored result instead of paying again", async () => {
    const { run, effect } = search();
    const payment = evmPayment(await freshSet(), withId("pay_7d5d747be160e280504c"));
    const first = await run({ payment, resource: SEARCH, context: { channel: "rest" } });
    const again = await run({ payment, resource: SEARCH, context: { channel: "rest" } });

    if (first.kind !== "ok") throw new Error(JSON.stringify(first));
    expect(again).toMatchObject({
      kind: "replay",
      payment: { id: first.payment.paymentId, status: "settled", tx: "0xtx1", paymentIdentifier: "pay_7d5d747be160e280504c" },
      settlement: { success: true, transaction: "0xtx1", network: "eip155:84532" },
    });
    expect(effect).toHaveBeenCalledOnce();
    expect(facilitator.calls.filter((c) => c.op === "settle")).toHaveLength(1);
  });

  it("same payment-identifier with a different payment is payment_reused", async () => {
    const { run } = search();
    const set = await freshSet();
    await run({ payment: evmPayment(set, withId("pay_shared_identifier_1")), resource: SEARCH, context: { channel: "rest" } });
    const out = await run({ payment: evmPayment(set, withId("pay_shared_identifier_1")), resource: SEARCH, context: { channel: "rest" } });
    expect(out).toMatchObject({ kind: "error", error: { code: "payment_reused" } });
  });

  it("the stored result is not handed to another company presenting the same payment", async () => {
    t.sqlite.exec(`INSERT INTO companies (id, name, terms_version, terms_accepted_at) VALUES ('co_a', 'A', 'v1', datetime('now'))`);
    const { run } = search();
    const payment = evmPayment(await freshSet(), withId("pay_company_scoped_0001"));
    await run({ payment, resource: SEARCH, context: { channel: "rest", companyId: "co_a" } });
    const out = await run({ payment, resource: SEARCH, context: { channel: "rest", companyId: null } });
    expect(out).toMatchObject({ kind: "error", error: { code: "payment_reused" } });
  });

  it("verify failure: 402 with the reason, no settle, no effect, payment marked failed", async () => {
    const { run, effect } = search();
    facilitator.verify = () => Response.json({ isValid: false, invalidReason: "insufficient_funds", payer: PAYER });
    const out = await run({ payment: evmPayment(await freshSet()), resource: SEARCH, context: { channel: "rest" } });

    expect(out).toMatchObject({ kind: "payment_required", response: { status: 402, body: { error: "insufficient_funds" } } });
    expect(effect).not.toHaveBeenCalled();
    expect(facilitator.calls.map((c) => c.op)).toEqual(["verify"]);
    expect(rows()[0]).toMatchObject({ status: "failed", error_reason: "insufficient_funds", tx: null });
  });

  it("verify rejected by the facilitator with an HTTP error body counts as invalid too", async () => {
    const { run, effect } = search();
    facilitator.verify = () => Response.json({ isValid: false, invalidReason: "invalid_exact_evm_payload_signature" }, { status: 400 });
    const out = await run({ payment: evmPayment(await freshSet()), resource: SEARCH, context: { channel: "rest" } });
    expect(out).toMatchObject({ kind: "payment_required", response: { body: { error: "invalid_exact_evm_payload_signature" } } });
    expect(effect).not.toHaveBeenCalled();
  });

  it("facilitator down during verify: retryable error, reservation released, same payment works later", async () => {
    const { run, effect } = search();
    const header = encodePaymentSignatureHeader(evmPayment(await freshSet()));
    facilitator.verify = () => new Response("bad gateway", { status: 502 });
    const down = await run({ payment: header, resource: SEARCH, context: { channel: "rest" } });
    expect(down).toMatchObject({ kind: "error", error: { status: 503, code: "internal" } });
    expect(rows()).toHaveLength(0);

    facilitator.verify = () => Response.json({ isValid: true, payer: PAYER });
    const retry = await run({ payment: header, resource: SEARCH, context: { channel: "rest" } });
    expect(retry.kind).toBe("ok");
    expect(effect).toHaveBeenCalledOnce();
  });

  it("settle failure (before_response): 402 with PAYMENT-RESPONSE success:false and no data", async () => {
    const { run, effect } = search();
    facilitator.settle = () =>
      Response.json({ success: false, errorReason: "transaction_failed", transaction: "", network: "eip155:84532" });
    const out = await run({ payment: evmPayment(await freshSet()), resource: SEARCH, context: { channel: "rest" } });

    if (out.kind !== "payment_required") throw new Error(JSON.stringify(out));
    expect(out).not.toHaveProperty("value");
    expect(JSON.stringify(out)).not.toContain("cand-1");
    expect(effect).toHaveBeenCalledOnce();
    expect(out.response.body.error).toBe("transaction_failed");
    expect(decodePaymentResponseHeader(out.response.headers["PAYMENT-RESPONSE"])).toMatchObject({
      success: false,
      errorReason: "transaction_failed",
    });
    expect(rows()[0]).toMatchObject({ status: "failed", error_reason: "transaction_failed", tx: null, settled_at: null });
  });

  it("settle failure (before_effect): the effect never runs", async () => {
    const gate = createPaymentGate({ db: t.db, config: devConfig() });
    const effect = vi.fn(async () => "intro");
    facilitator.settle = () => Response.json({ success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:84532" }, { status: 400 });
    const run = gate.withPayment("request_intro", "before_effect", { effect });
    const set = await gate.requirementsFor("request_intro", SEARCH);
    const out = await run({ payment: evmPayment(set), resource: SEARCH, context: { channel: "rest" } });

    expect(out).toMatchObject({ kind: "payment_required", settlement: { success: false, errorReason: "insufficient_funds" } });
    expect(effect).not.toHaveBeenCalled();
    expect(rows()[0]).toMatchObject({ status: "failed" });
  });

  it("settle timeout is recorded as unconfirmed and returns no data", async () => {
    const { run } = search();
    facilitator.settle = () => {
      throw new TypeError("network connection lost");
    };
    const out = await run({ payment: evmPayment(await freshSet()), resource: SEARCH, context: { channel: "rest" } });
    expect(out).toMatchObject({ kind: "payment_required", settlement: { success: false, errorReason: "settle_unconfirmed" } });
    expect(rows()[0]).toMatchObject({ status: "failed" });
    expect(String(rows()[0].error_reason)).toMatch(/^settle_unconfirmed: /);
  });

  it("a transaction already recorded for another payment does not count as payment", async () => {
    const { run, effect } = search();
    facilitator.settle = () => Response.json({ success: true, transaction: "0xsame", network: "eip155:84532" });
    const set = await freshSet();
    const first = await run({ payment: evmPayment(set), resource: SEARCH, context: { channel: "rest" } });
    const second = await run({ payment: evmPayment(set), resource: SEARCH, context: { channel: "rest" } });
    expect(first.kind).toBe("ok");
    expect(second).toMatchObject({ kind: "payment_required", settlement: { success: false, errorReason: "duplicate_transaction" } });
    expect(effect).toHaveBeenCalledTimes(2);
    expect(rows().map((r) => r.status)).toEqual(["settled", "failed"]);
  });

  it("validation failure after verify: nothing settled, reservation released for a corrected retry", async () => {
    const gate = createPaymentGate({ db: t.db, config: devConfig() });
    const effect = vi.fn(async () => "intro");
    let cooldown = true;
    const run = gate.withPayment("request_intro", "before_effect", {
      validate: async () => (cooldown ? { code: "intro_cooldown" } : undefined),
      effect,
    });
    const header = encodePaymentSignatureHeader(evmPayment(await gate.requirementsFor("request_intro", SEARCH)));
    const rejected = await run({ payment: header, resource: SEARCH, context: { channel: "rest" } });
    expect(rejected).toEqual({ kind: "rejected", error: { code: "intro_cooldown" } });
    expect(facilitator.calls.map((c) => c.op)).toEqual(["verify"]);
    expect(effect).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);

    cooldown = false;
    expect((await run({ payment: header, resource: SEARCH, context: { channel: "rest" } })).kind).toBe("ok");
  });

  it("paid but the effect failed: 500 with payment_id, payment stays settled", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const gate = createPaymentGate({ db: t.db, config: devConfig() });
    const run = gate.withPayment("buy_usdc_month", "before_effect", {
      effect: async () => {
        throw new Error("D1 unavailable");
      },
    });
    const out = await run({
      payment: evmPayment(await gate.requirementsFor("buy_usdc_month", SEARCH)),
      resource: SEARCH,
      context: { channel: "rest" },
    });
    if (out.kind !== "error") throw new Error(JSON.stringify(out));
    expect(out.error).toMatchObject({ status: 500, code: "internal" });
    expect(rows()[0]).toMatchObject({ id: out.error.details!.payment_id, status: "settled" });
  });

  it("a garbled header or a payment for other terms gets 402 and no reservation", async () => {
    const { run, effect } = search();
    const garbled = await run({ payment: "not base64 !!", resource: SEARCH, context: { channel: "rest" } });
    expect(garbled).toMatchObject({ kind: "payment_required", response: { body: { error: expect.stringMatching(/^invalid_payment/) } } });

    const cheap = evmPayment(await freshSet());
    cheap.accepted = { ...cheap.accepted, amount: "1" };
    const mismatch = await run({ payment: cheap, resource: SEARCH, context: { channel: "rest" } });
    expect(mismatch).toMatchObject({ kind: "payment_required", response: { body: { error: "No matching payment requirements" } } });

    const badId = evmPayment(await freshSet(), withId("short"));
    const invalidId = await run({ payment: badId, resource: SEARCH, context: { channel: "rest" } });
    expect(invalidId).toMatchObject({ kind: "payment_required", response: { body: { error: expect.stringMatching(/^invalid_payment_identifier/) } } });

    expect(effect).not.toHaveBeenCalled();
    expect(facilitator.calls).toHaveLength(0);
    expect(rows()).toHaveLength(0);
  });
});

describe("without keys", () => {
  it("production: every paid call is not_configured and names the missing setting", async () => {
    const gate = createPaymentGate({ db: t.db, config: readX402Config(PAY_TO, "production") });
    expect(gate.enabled).toBe(false);
    const effect = vi.fn(async () => "data");
    const out = await gate.withPayment("search_candidates", "before_response", { effect })({
      payment: undefined,
      resource: SEARCH,
      context: { channel: "rest" },
    });
    expect(out).toEqual({
      kind: "error",
      error: { status: 401, code: "not_configured", message: "not configured: CDP_API_KEY_ID, CDP_API_KEY_SECRET" },
    });
    await expect(gate.requirementsFor("search_candidates", SEARCH)).rejects.toMatchObject({ gate: { code: "not_configured" } });
    expect(effect).not.toHaveBeenCalled();
    expect(facilitator.supportedCalls).toBe(0);
  });

  it("development: the same settings work on the test networks through x402.org", async () => {
    const seen: string[] = [];
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => {
      seen.push(String(input));
      return inner(input, init);
    });
    const gate = createPaymentGate({ db: t.db, config: readX402Config(PAY_TO, "development") });
    const set = await gate.requirementsFor("search_candidates", SEARCH);
    expect(gate.enabled).toBe(true);
    expect(seen).toEqual(["https://x402.org/facilitator/supported"]);
    expect(set.accepts.map((a) => a.network)).toEqual(["eip155:84532", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"]);
  });
});
