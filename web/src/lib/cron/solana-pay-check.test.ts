import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInvoice, findConfirmedMonth, loadInvoice, SOLANA_PAY_INVOICE_TTL_MINUTES, USDC_MINT_MAINNET } from "@/lib/billing/solana-pay";
import { addCompany, crmDb } from "@/test/crm-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { checkPendingSolanaPay } from "./solana-pay-check";

const NOW = new Date("2026-09-15T12:00:00Z");
const OWNER = "6XsRJx1yp4AcNk19wZkaK4y3GCcMd4aArny6owTqCt6L";
const PAYER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const ENV = { NCJ_PAY_ADDRESS: OWNER, SOLANA_RPC_URL: "https://helius.example/rpc" };

let db: TestDb;
let company: string;

beforeEach(() => {
  db = crmDb();
  company = addCompany(db.raw);
});

describe("checkPendingSolanaPay", () => {
  it("without NCJ_PAY_ADDRESS/SOLANA_RPC_URL only expires stale invoices, asks the network for nothing", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const stale = await createInvoice(db.d1, company, null, new Date(NOW.getTime() - 2 * SOLANA_PAY_INVOICE_TTL_MINUTES * 60_000));
    const res = await checkPendingSolanaPay(db.d1, {}, NOW);
    expect(res).toEqual({ expired: 1, checked: 0, confirmed: 0, errors: 0, duplicates: 0 });
    expect(fetch).not.toHaveBeenCalled();
    expect((await loadInvoice(db.d1, company, stale.id))!.status).toBe("expired");
    vi.unstubAllGlobals();
  });

  it("confirms an invoice whose payment is found on chain, and grants access", async () => {
    const invoice = await createInvoice(db.d1, company, null, NOW);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { method: string; id: number };
        const result =
          body.method === "getSignaturesForAddress"
            ? [{ signature: "sig1", err: null }]
            : {
                transaction: { message: { accountKeys: [{ pubkey: PAYER, signer: true }] } },
                meta: {
                  err: null,
                  preTokenBalances: [],
                  postTokenBalances: [{ accountIndex: 0, mint: USDC_MINT_MAINNET, owner: OWNER, uiTokenAmount: { amount: "100000000", decimals: 6 } }],
                },
              };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200 });
      }),
    );
    const res = await checkPendingSolanaPay(db.d1, ENV, NOW);
    expect(res).toEqual({ expired: 0, checked: 1, confirmed: 1, errors: 0, duplicates: 0 });
    const row = await loadInvoice(db.d1, company, invoice.id);
    expect(row).toMatchObject({ status: "confirmed", tx: "sig1", payer: PAYER });
    expect(await findConfirmedMonth(db.d1, invoice.id)).not.toBeNull();
    vi.unstubAllGlobals();
  });

  it("leaves an invoice pending and counts an error when the RPC fails, without expiring it early", async () => {
    const invoice = await createInvoice(db.d1, company, null, NOW);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    const res = await checkPendingSolanaPay(db.d1, ENV, NOW);
    expect(res).toEqual({ expired: 0, checked: 1, confirmed: 0, errors: 1, duplicates: 0 });
    expect((await loadInvoice(db.d1, company, invoice.id))!.status).toBe("pending");
    vi.unstubAllGlobals();
  });

  it("a tx already applied to another invoice does not abort the loop: that invoice is closed and logged, the rest still confirm", async () => {
    const a = await createInvoice(db.d1, company, null, NOW);
    const b = await createInvoice(db.d1, company, null, new Date(NOW.getTime() + 1000));
    const c = await createInvoice(db.d1, company, null, new Date(NOW.getTime() + 2000));
    // Один підпис знайдено на двох посиланнях (a, b), третє має свій.
    const sigFor = new Map([[a.reference, "sigSHARED"], [b.reference, "sigSHARED"], [c.reference, "sigOWN"]]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { method: string; id: number; params: unknown[] };
        const result =
          body.method === "getSignaturesForAddress"
            ? [{ signature: sigFor.get(String(body.params[0])), err: null }]
            : {
                transaction: { message: { accountKeys: [{ pubkey: PAYER, signer: true }] } },
                meta: {
                  err: null,
                  preTokenBalances: [],
                  postTokenBalances: [{ accountIndex: 0, mint: USDC_MINT_MAINNET, owner: OWNER, uiTokenAmount: { amount: "100000000", decimals: 6 } }],
                },
              };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200 });
      }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await checkPendingSolanaPay(db.d1, ENV, NOW);
    expect(res).toEqual({ expired: 0, checked: 3, confirmed: 2, errors: 0, duplicates: 1 });
    expect((await loadInvoice(db.d1, company, a.id))!.status).toBe("confirmed");
    expect((await loadInvoice(db.d1, company, b.id))!.status).toBe("expired");
    expect((await loadInvoice(db.d1, company, c.id))!.status).toBe("confirmed");
    // Ні зайвого місяця за дубль: дві підписки, не три.
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE company_id = ?").get(company)).toEqual({ n: 2 });
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'solana_pay.duplicate_tx' AND target = ?").get(b.id)).toEqual({ n: 1 });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
});
