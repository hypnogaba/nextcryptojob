import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-d1";
import { addCompany, addSubscription, all, crmDb, run } from "@/test/crm-fixtures";
import {
  base58Decode, base58Encode, confirmInvoice, createInvoice, expireStaleInvoices, findConfirmedMonth, listPendingInvoices,
  loadInvoice, randomReference, readSolanaPayConfig, SOLANA_PAY_AMOUNT_USDC, SOLANA_PAY_INVOICE_TTL_MINUTES, solanaPayUrl,
  USDC_MINT_MAINNET, verifyOnChain,
} from "./solana-pay";

const NOW = new Date("2026-09-15T12:00:00Z");
// Адреса власника з п.8 (владник, 15.09, «перевірено: 32 байти»).
const OWNER = "6XsRJx1yp4AcNk19wZkaK4y3GCcMd4aArny6owTqCt6L";
const PAYER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const RPC_URL = "https://helius.example/rpc";

describe("base58", () => {
  it("32 zero bytes give 32 leading '1's (the well-known encoding of an all-zero pubkey)", () => {
    expect(base58Encode(new Uint8Array(32))).toBe("1".repeat(32));
  });

  it("round-trips arbitrary bytes", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
  });

  it("a real Solana address decodes to exactly 32 bytes (owner address, verified by hand 15.09)", () => {
    expect(base58Decode(OWNER)).toHaveLength(32);
    expect(base58Decode(USDC_MINT_MAINNET)).toHaveLength(32);
  });

  it("rejects a character outside the alphabet (0, O, I, l are excluded on purpose)", () => {
    expect(() => base58Decode("0")).toThrow(/not in the alphabet/);
  });
});

describe("randomReference", () => {
  it("gives a fresh, 32-byte-shaped base58 string each time", () => {
    const a = randomReference();
    const b = randomReference();
    expect(a).not.toBe(b);
    expect(base58Decode(a)).toHaveLength(32);
  });
});

describe("readSolanaPayConfig", () => {
  it("enabled with both variables set", () => {
    expect(readSolanaPayConfig({ NCJ_PAY_ADDRESS: OWNER, SOLANA_RPC_URL: RPC_URL })).toEqual({ enabled: true, payTo: OWNER, rpcUrl: RPC_URL });
  });

  it("disabled and names what is missing, without leaking the RPC URL", () => {
    const config = readSolanaPayConfig({});
    expect(config).toMatchObject({ enabled: false, reason: "not configured: NCJ_PAY_ADDRESS, SOLANA_RPC_URL" });
    expect(JSON.stringify(config)).not.toContain("helius");
  });

  it("rejects a malformed pay-to address instead of sending money to it", () => {
    expect(readSolanaPayConfig({ NCJ_PAY_ADDRESS: "not-an-address", SOLANA_RPC_URL: RPC_URL })).toMatchObject({
      enabled: false, missing: ["NCJ_PAY_ADDRESS (invalid address)"],
    });
  });
});

describe("solanaPayUrl", () => {
  it("builds a solana: transfer-request URI with the USDC mint, amount and reference", () => {
    const url = solanaPayUrl({ payTo: OWNER, amount: 100, reference: PAYER, label: "NextCryptoJob", message: "100 USDC for 30 days" });
    expect(url).toBe(
      `solana:${OWNER}?amount=100&spl-token=${USDC_MINT_MAINNET}&reference=${PAYER}&label=NextCryptoJob&message=100+USDC+for+30+days`,
    );
  });
});

describe("invoices (0025 solana_pay_invoices)", () => {
  let db: TestDb;
  let company: string;

  beforeEach(() => {
    db = crmDb();
    company = addCompany(db.raw);
  });

  it("creates a pending invoice for 100 USDC with a fresh reference and an expiry", async () => {
    const inv = await createInvoice(db.d1, company, null, NOW);
    expect(inv).toMatchObject({ companyId: company, amountUsdc: SOLANA_PAY_AMOUNT_USDC, status: "pending", tx: null });
    expect(base58Decode(inv.reference)).toHaveLength(32);
    expect(new Date(inv.expiresAt).getTime()).toBe(NOW.getTime() + SOLANA_PAY_INVOICE_TTL_MINUTES * 60_000);
    expect(await loadInvoice(db.d1, company, inv.id)).toEqual(inv);
  });

  it("does not leak another company's invoice", async () => {
    const other = addCompany(db.raw);
    const inv = await createInvoice(db.d1, company, null, NOW);
    expect(await loadInvoice(db.d1, other, inv.id)).toBeNull();
  });

  it("lists only pending, unexpired invoices, oldest first", async () => {
    const a = await createInvoice(db.d1, company, null, new Date(NOW.getTime() - 1000));
    const b = await createInvoice(db.d1, company, null, NOW);
    run(db.raw, "UPDATE solana_pay_invoices SET status = 'confirmed' WHERE id = ?", a.id);
    const c = await createInvoice(db.d1, company, null, NOW);
    run(db.raw, "UPDATE solana_pay_invoices SET expires_at = ? WHERE id = ?", "2020-01-01 00:00:00", c.id);
    expect((await listPendingInvoices(db.d1, NOW, 10)).map((i) => i.id)).toEqual([b.id]);
  });

  it("expireStaleInvoices marks only pending invoices past their expiry", async () => {
    const fresh = await createInvoice(db.d1, company, null, NOW);
    const stale = await createInvoice(db.d1, company, null, new Date(NOW.getTime() - 2 * SOLANA_PAY_INVOICE_TTL_MINUTES * 60_000));
    const n = await expireStaleInvoices(db.d1, NOW);
    expect(n).toBe(1);
    expect((await loadInvoice(db.d1, company, stale.id))!.status).toBe("expired");
    expect((await loadInvoice(db.d1, company, fresh.id))!.status).toBe("pending");
  });
});

describe("confirmInvoice", () => {
  let db: TestDb;
  let company: string;

  beforeEach(() => {
    db = crmDb();
    company = addCompany(db.raw);
  });

  it("grants 30 days starting now when the company has no active USDC period", async () => {
    const inv = await createInvoice(db.d1, company, null, NOW);
    const month = await confirmInvoice(db.d1, inv, "5tx1", PAYER, NOW);
    const sub = all(db.raw, "SELECT * FROM subscriptions WHERE id = ?", month.subscriptionId)[0] as Record<string, unknown>;
    expect(sub).toMatchObject({ provider: "usdc", status: "active", company_id: company });
    expect(new Date(month.periodEnd).getTime() - NOW.getTime()).toBe(30 * 86_400_000);
    const row = await loadInvoice(db.d1, company, inv.id);
    expect(row).toMatchObject({ status: "confirmed", tx: "5tx1", payer: PAYER, subscriptionId: month.subscriptionId });
  });

  it("stacks after an existing active USDC period instead of starting from now", async () => {
    addSubscription(db.raw, company, { provider: "usdc", end: "2026-10-01 00:00:00" });
    const inv = await createInvoice(db.d1, company, null, NOW);
    const month = await confirmInvoice(db.d1, inv, "5tx2", PAYER, NOW);
    expect(month.periodEnd).toBe("2026-10-31T00:00:00Z");
  });

  it("is idempotent: confirming the same invoice twice creates one subscription row", async () => {
    const inv = await createInvoice(db.d1, company, null, NOW);
    const first = await confirmInvoice(db.d1, inv, "5tx3", PAYER, NOW);
    const second = await confirmInvoice(db.d1, { ...inv, status: "confirmed" }, "5tx3", PAYER, NOW);
    expect(second).toEqual(first);
    expect(all(db.raw, "SELECT COUNT(*) AS n FROM subscriptions WHERE company_id = ?", company)[0]).toEqual({ n: 1 });
  });

  it("findConfirmedMonth is null before confirmation", async () => {
    const inv = await createInvoice(db.d1, company, null, NOW);
    expect(await findConfirmedMonth(db.d1, inv.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// verifyOnChain: RPC на заглушці (записані відповіді, без мережі)

const REFERENCE = "5tX7qkJmS9tqK3Q8mRZ8y1jf7YhVoJHKtjqPPvHhY9wz";

function fakeRpc(handlers: Record<string, (params: unknown[]) => unknown>) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[]; id: number };
    const handler = handlers[body.method];
    if (!handler) throw new Error(`unexpected rpc method ${body.method}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: handler(body.params) }), { status: 200 });
  }) as unknown as typeof fetch;
}

/** Форма getTransaction (jsonParsed), скорочена до полів, які читає verifyOnChain. */
function jsonParsedTx(o: { err?: unknown; pre?: number; post: number; payer?: string; signer?: string }) {
  return {
    transaction: { message: { accountKeys: [{ pubkey: o.signer ?? PAYER, signer: true }] } },
    meta: {
      err: o.err ?? null,
      preTokenBalances: o.pre === undefined ? [] : [{ accountIndex: 0, mint: USDC_MINT_MAINNET, owner: OWNER, uiTokenAmount: { amount: String(o.pre * 1_000_000), decimals: 6 } }],
      postTokenBalances: [
        { accountIndex: 0, mint: USDC_MINT_MAINNET, owner: OWNER, uiTokenAmount: { amount: String(o.post * 1_000_000), decimals: 6 } },
        ...(o.payer ? [{ accountIndex: 1, mint: USDC_MINT_MAINNET, owner: o.payer, uiTokenAmount: { amount: "0", decimals: 6 } }] : []),
      ],
    },
  };
}

describe("verifyOnChain (recorded RPC fixtures, no live network)", () => {
  it("no signatures yet for the reference: pending", async () => {
    const fetchImpl = fakeRpc({ getSignaturesForAddress: () => [] });
    expect(await verifyOnChain(RPC_URL, REFERENCE, OWNER, 100, fetchImpl)).toEqual({ status: "pending" });
  });

  it("a signature exists but the owner's USDC balance did not move: pending (wrong tx caught the reference by chance)", async () => {
    const fetchImpl = fakeRpc({
      getSignaturesForAddress: () => [{ signature: "sig1", err: null }],
      getTransaction: () => jsonParsedTx({ pre: 500, post: 500 }),
    });
    expect(await verifyOnChain(RPC_URL, REFERENCE, OWNER, 100, fetchImpl)).toEqual({ status: "pending" });
  });

  it("exact payment confirms with the tx signature and the payer address", async () => {
    const fetchImpl = fakeRpc({
      getSignaturesForAddress: () => [{ signature: "sig2", err: null }],
      getTransaction: () => jsonParsedTx({ pre: 500, post: 600, payer: PAYER }),
    });
    expect(await verifyOnChain(RPC_URL, REFERENCE, OWNER, 100, fetchImpl)).toEqual({ status: "confirmed", tx: "sig2", payer: PAYER });
  });

  it("no prior balance row (fresh ATA): pre treated as 0, still confirms", async () => {
    const fetchImpl = fakeRpc({
      getSignaturesForAddress: () => [{ signature: "sig3", err: null }],
      getTransaction: () => jsonParsedTx({ post: 100, payer: PAYER }),
    });
    expect(await verifyOnChain(RPC_URL, REFERENCE, OWNER, 100, fetchImpl)).toEqual({ status: "confirmed", tx: "sig3", payer: PAYER });
  });

  it("underpayment (partial transfer under the same reference) does not confirm", async () => {
    const fetchImpl = fakeRpc({
      getSignaturesForAddress: () => [{ signature: "sig4", err: null }],
      getTransaction: () => jsonParsedTx({ pre: 500, post: 599.999999, payer: PAYER }),
    });
    expect(await verifyOnChain(RPC_URL, REFERENCE, OWNER, 100, fetchImpl)).toEqual({ status: "pending" });
  });

  it("a failed signature is skipped, an earlier confirmed one still counts", async () => {
    const fetchImpl = fakeRpc({
      getSignaturesForAddress: () => [
        { signature: "sig_failed", err: { InstructionError: [0, "Custom"] } },
        { signature: "sig_ok", err: null },
      ],
      getTransaction: (params) => (params[0] === "sig_ok" ? jsonParsedTx({ pre: 0, post: 100, payer: PAYER }) : null),
    });
    expect(await verifyOnChain(RPC_URL, REFERENCE, OWNER, 100, fetchImpl)).toEqual({ status: "confirmed", tx: "sig_ok", payer: PAYER });
  });

  it("RPC error surfaces as status 'error', not a silent pending", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "rate limited", code: 429 } }), { status: 200 })) as unknown as typeof fetch;
    const out = await verifyOnChain(RPC_URL, REFERENCE, OWNER, 100, fetchImpl);
    expect(out).toEqual({ status: "error", reason: "solana rpc: rate limited (429)" });
  });

  it("an HTTP failure from the RPC provider surfaces as an error", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    expect(await verifyOnChain(RPC_URL, REFERENCE, OWNER, 100, fetchImpl)).toEqual({ status: "error", reason: "solana rpc: HTTP 503" });
  });
});
