import { beforeEach, describe, expect, it } from "vitest";
import { __resetLimiters } from "../limits.js";
import { collectSolana, DEX_PROGRAMS, estimateSwaps, isSwapTx, type ParsedTx, type SolanaOptions } from "./solana.js";

// Синтетичні відповіді за формою Solana JSON-RPC (getSignaturesForAddress, getTransaction jsonParsed).
const OWNER = "Synth" + "1".repeat(35);
const OTHER = "Other" + "2".repeat(35);
const KEY = "helius-SECRET-789";
const JUP6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const WHIRL = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM = "11111111111111111111111111111111";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

const bal = (mint: string, amount: string, owner = OWNER, accountIndex = 1) =>
  ({ accountIndex, mint, owner, programId: TOKEN, uiTokenAmount: { amount, decimals: 6, uiAmount: null, uiAmountString: amount } });

const tx = (o: { outer?: string[]; inner?: string[]; keys?: string[]; pre?: unknown[]; post?: unknown[]; loaded?: string[] } = {}): ParsedTx => ({
  transaction: {
    message: {
      accountKeys: [{ pubkey: OWNER, signer: true, source: "transaction", writable: true } as { pubkey: string }, ...(o.keys ?? [SYSTEM]).map((k) => ({ pubkey: k }))],
      instructions: (o.outer ?? [SYSTEM]).map((p) => ({ programId: p, accounts: [], data: "" })),
    },
  },
  meta: {
    innerInstructions: o.inner ? [{ instructions: o.inner.map((p) => ({ programId: p })) }] : [],
    preTokenBalances: (o.pre ?? []) as never, postTokenBalances: (o.post ?? []) as never,
    loadedAddresses: { writable: o.loaded ?? [], readonly: [] },
  },
});

describe("isSwapTx", () => {
  it("програма DEX у зовнішній інструкції, у вкладеній, серед адрес чи в адресах із таблиці", () => {
    expect(isSwapTx(tx({ outer: ["ComputeBudget111111111111111111111111111111", JUP6] }), OWNER)).toBe(true);
    expect(isSwapTx(tx({ inner: [TOKEN, WHIRL] }), OWNER)).toBe(true);
    expect(isSwapTx(tx({ keys: [SYSTEM, "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"] }), OWNER)).toBe(true);
    const plainKeys: ParsedTx = { transaction: { message: { accountKeys: [OWNER, "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"], instructions: [] } }, meta: null };
    expect(isSwapTx(plainKeys, OWNER)).toBe(true);
    expect(isSwapTx(tx({ loaded: ["dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"] }), OWNER)).toBe(true);
  });

  it("усі 13 програм DEX у переліку", () => {
    expect(DEX_PROGRAMS.size).toBe(13);
  });

  it("евристика: у власника один токен прибув, інший убув", () => {
    expect(isSwapTx(tx({ pre: [bal(USDC, "5000000"), bal(BONK, "0", OWNER, 2)], post: [bal(USDC, "0"), bal(BONK, "123456", OWNER, 2)] }), OWNER)).toBe(true);
    // Лише прибуло: переказ, а не обмін.
    expect(isSwapTx(tx({ pre: [bal(USDC, "0")], post: [bal(USDC, "5000000")] }), OWNER)).toBe(false);
    // Зміни в чужих рахунках не рахуються.
    expect(isSwapTx(tx({ pre: [bal(USDC, "5", OTHER), bal(BONK, "0", OTHER, 2)], post: [bal(USDC, "0", OTHER), bal(BONK, "9", OTHER, 2)] }), OWNER)).toBe(false);
    // Звичайний переказ SOL: не обмін.
    expect(isSwapTx(tx(), OWNER)).toBe(false);
  });

  it("кілька рахунків того самого токена сумуються: перекладання між своїми рахунками не обмін", () => {
    const pre = [bal(USDC, "100", OWNER, 1), bal(USDC, "0", OWNER, 2), bal(BONK, "7", OWNER, 3)];
    const post = [bal(USDC, "0", OWNER, 1), bal(USDC, "100", OWNER, 2), bal(BONK, "3", OWNER, 3)];
    expect(isSwapTx(tx({ pre, post }), OWNER)).toBe(false);
  });

  it("uiAmount = null не заважає: рахуємо сирі amount", () => {
    expect(isSwapTx(tx({ pre: [bal(USDC, "1"), bal(BONK, "0", OWNER, 2)], post: [bal(USDC, "0"), bal(BONK, "1", OWNER, 2)] }), OWNER)).toBe(true);
  });
});

describe("estimateSwaps", () => {
  it("вибірка менше 50: null; 50 і більше: частка × успішні підписи", () => {
    expect(estimateSwaps(49, 49, 1000)).toBeNull();
    expect(estimateSwaps(0, 0, 0)).toBeNull();
    expect(estimateSwaps(50, 10, 1000)).toBe(200);
    expect(estimateSwaps(150, 1, 6301)).toBe(42);
    expect(estimateSwaps(150, 0, 6301)).toBe(0);
  });
});

// --- збирач з підміненим RPC ---

type Sig = { signature: string; slot: number; err: unknown; memo: null; blockTime: number | null; confirmationStatus: string };
const sigs = (n: number, o: { errEvery?: number; start?: number } = {}): Sig[] =>
  Array.from({ length: n }, (_, i) => ({
    signature: `sig${(o.start ?? 0) + i}`, slot: 1_000_000 - i, memo: null, confirmationStatus: "finalized",
    err: o.errEvery && i % o.errEvery === o.errEvery - 1 ? { InstructionError: [0, { Custom: 1 }] } : null,
    blockTime: 1_780_000_000 - i * 60,
  }));

type RpcCall = { url: URL; method: string; params: unknown[]; at: number };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const ok = (result: unknown) => json({ jsonrpc: "2.0", id: 1, result });

function rpcFake(o: {
  sigList: Sig[];
  txs?: Record<string, ParsedTx | null>;
  onSigPage?: (page: number) => Response | undefined;
  onTx?: (sig: string) => Response | undefined;
  delayMs?: number;
}) {
  const calls: RpcCall[] = [];
  let inFlight = 0, maxTxInFlight = 0, sigPage = 0;
  const fetchImpl = (async (u: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    calls.push({ url: new URL(String(u)), method: body.method, params: body.params, at: performance.now() });
    if (body.method === "getSignaturesForAddress") {
      sigPage++;
      const special = o.onSigPage?.(sigPage);
      if (special) return special;
      const opts = body.params[1] as { limit: number; before?: string };
      const from = opts.before ? o.sigList.findIndex((s) => s.signature === opts.before) + 1 : 0;
      return ok(o.sigList.slice(from, from + opts.limit));
    }
    const sig = body.params[0] as string;
    inFlight++; maxTxInFlight = Math.max(maxTxInFlight, inFlight);
    try {
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      const special = o.onTx?.(sig);
      if (special) return special;
      return ok(o.txs && sig in o.txs ? o.txs[sig] : tx());
    } finally { inFlight--; }
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, of: (m: string) => calls.filter((c) => c.method === m), maxTxInFlight: () => maxTxInFlight };
}

const base = (fetchImpl: typeof fetch, env: Record<string, string> = { HELIUS_KEY: KEY }): SolanaOptions =>
  ({ fetchImpl, env, retries: 0, retryDelayMs: 0, rateLimitBackoffMs: 10 });

beforeEach(() => { __resetLimiters(); });

describe("collectSolana", () => {
  it("Helius: сторінки підписів, успішні, вік, вибірка з останніх успішних, 4 паралельно", async () => {
    const list = sigs(1300, { errEvery: 10 });
    list[1299]!.blockTime = null; // blockTime буває порожнім
    const okSigs = list.filter((s) => !s.err).map((s) => s.signature);
    const txs: Record<string, ParsedTx> = {
      [okSigs[0]!]: tx({ outer: [JUP6] }),
      [okSigs[3]!]: tx({ inner: [WHIRL] }),
      [okSigs[6]!]: tx({ pre: [bal(USDC, "5"), bal(BONK, "0", OWNER, 2)], post: [bal(USDC, "0"), bal(BONK, "9", OWNER, 2)] }),
    };
    const f = rpcFake({ sigList: list, txs, delayMs: 450 });
    const res = await collectSolana([OWNER], { ...base(f.fetchImpl), sampleSize: 8, minSample: 5 });
    if (!res.ok) throw new Error(res.gap);
    expect(res.facts[OWNER]).toEqual({
      sigs: 1300, sigsOk: 1170, sigsCapped: false, firstTs: 1_780_000_000 - 1298 * 60,
      sampleSeen: 8, sampleSwaps: 3, swaps: Math.round((3 / 8) * 1170),
    });
    const pages = f.of("getSignaturesForAddress");
    expect(pages).toHaveLength(2);
    expect(pages[0]!.url.toString()).toBe(`https://mainnet.helius-rpc.com/?api-key=${KEY}`);
    expect(pages[0]!.params).toEqual([OWNER, { limit: 1000 }]);
    expect(pages[1]!.params).toEqual([OWNER, { limit: 1000, before: "sig999" }]);
    const txCalls = f.of("getTransaction");
    expect(txCalls.map((c) => c.params[0])).toEqual(okSigs.slice(0, 8));
    expect(txCalls[0]!.params[1]).toEqual({ encoding: "jsonParsed", maxSupportedTransactionVersion: 0 });
    expect(f.maxTxInFlight()).toBe(4);
  });

  it("без HELIUS_KEY: публічний RPC, транзакції по одній", async () => {
    const f = rpcFake({ sigList: sigs(5), delayMs: 5 });
    const res = await collectSolana([OWNER], { ...base(f.fetchImpl, {}), sampleSize: 3, minSample: 3 });
    if (!res.ok) throw new Error(res.gap);
    expect(f.calls[0]!.url.toString()).toBe("https://api.mainnet-beta.solana.com/");
    expect(f.maxTxInFlight()).toBe(1);
    expect(res.facts[OWNER]).toMatchObject({ sigs: 5, sampleSeen: 3, sampleSwaps: 0, swaps: 0 });
  });

  it("вибірка менше 50 (типова межа): swaps = null, решта фактів є", async () => {
    const f = rpcFake({ sigList: sigs(4), txs: { sig0: tx({ outer: [JUP6] }) } });
    const res = await collectSolana([OWNER], base(f.fetchImpl));
    if (!res.ok) throw new Error(res.gap);
    expect(res.facts[OWNER]).toEqual({ sigs: 4, sigsOk: 4, sigsCapped: false, firstTs: 1_780_000_000 - 3 * 60, sampleSeen: 4, sampleSwaps: 1, swaps: null });
  });

  it("10 повних сторінок: sigsCapped, вік невідомий, одинадцятої сторінки немає", async () => {
    const f = rpcFake({ sigList: sigs(10_500) });
    const res = await collectSolana([OWNER], { ...base(f.fetchImpl), sampleSize: 0 });
    if (!res.ok) throw new Error(res.gap);
    expect(res.facts[OWNER]).toMatchObject({ sigs: 10_000, sigsOk: 10_000, sigsCapped: true, firstTs: null, sampleSeen: 0, swaps: null });
    expect(f.of("getSignaturesForAddress")).toHaveLength(10);
  });

  it("збій другої сторінки: лічба як нижня межа (sigsCapped), вік невідомий", async () => {
    const f = rpcFake({ sigList: sigs(1500), onSigPage: (p) => (p === 2 ? new Response("down", { status: 503 }) : undefined) });
    const res = await collectSolana([OWNER], { ...base(f.fetchImpl), sampleSize: 0 });
    if (!res.ok) throw new Error(res.gap);
    expect(res.facts[OWNER]).toMatchObject({ sigs: 1000, sigsCapped: true, firstTs: null });
  });

  it("транзакція, якої немає (null) або що не відповіла, у вибірку не йде", async () => {
    const f = rpcFake({
      sigList: sigs(6), txs: { sig1: null },
      onTx: (s) => (s === "sig2" ? new Response("x", { status: 500 }) : undefined),
    });
    const res = await collectSolana([OWNER], { ...base(f.fetchImpl), sampleSize: 6, minSample: 4 });
    if (!res.ok) throw new Error(res.gap);
    expect(res.facts[OWNER]).toMatchObject({ sampleSeen: 4, sampleSwaps: 0, swaps: 0 });
  });

  it("ліміт у тілі JSON-RPC (-32429): бюджет відсувається, запит повторюється", async () => {
    let limited = 1;
    const f = rpcFake({
      sigList: sigs(3),
      onSigPage: () => (limited-- > 0 ? json({ jsonrpc: "2.0", id: 1, error: { code: -32429, message: "rate limited" } }) : undefined),
    });
    const res = await collectSolana([OWNER], { ...base(f.fetchImpl), sampleSize: 0, rateLimitBackoffMs: 300 });
    if (!res.ok) throw new Error(res.gap);
    expect(res.facts[OWNER]!.sigs).toBe(3);
    const pages = f.of("getSignaturesForAddress");
    expect(pages).toHaveLength(2);
    expect(pages[1]!.at - pages[0]!.at).toBeGreaterThanOrEqual(280);
  });

  it("перша сторінка не відповіла: без ключа прогалина not configured: HELIUS_KEY, з ключем без ключа в тексті", async () => {
    const down = rpcFake({ sigList: [], onSigPage: () => new Response("busy", { status: 503 }) });
    const noKey = await collectSolana([OWNER], base(down.fetchImpl, {}));
    expect(noKey.ok).toBe(false);
    if (!noKey.ok) expect(noKey.gap).toMatch(/^not configured: HELIUS_KEY; public api\.mainnet-beta\.solana\.com failed: /);

    __resetLimiters();
    const err = rpcFake({ sigList: [], onSigPage: () => json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid param: WrongSize" } }) });
    const withKey = await collectSolana([OWNER], base(err.fetchImpl));
    expect(withKey.ok).toBe(false);
    if (!withKey.ok) {
      expect(withKey.gap).toMatch(/^Solana: mainnet\.helius-rpc\.com: getSignaturesForAddress: Invalid param/);
      expect(withKey.gap).not.toContain(KEY);
    }
  });

  it("одна з двох адрес не відповіла: друга у фактах, перша в partial", async () => {
    const SECOND = "Second" + "3".repeat(34);
    const f = rpcFake({ sigList: sigs(2) });
    const fetchImpl = (async (u: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: unknown[] };
      if (body.params[0] === SECOND) return new Response("x", { status: 500 });
      return f.fetchImpl(u, init);
    }) as unknown as typeof fetch;
    const res = await collectSolana([OWNER, SECOND], { ...base(fetchImpl), sampleSize: 0 });
    if (!res.ok) throw new Error(res.gap);
    expect(Object.keys(res.facts)).toEqual([OWNER]);
    expect(res.partial?.[SECOND]).toMatch(/mainnet\.helius-rpc\.com/);
    expect(JSON.stringify(res)).not.toContain(KEY);
  });

  it("неправильна адреса не йде в мережу; SOL_SAMPLE з оточення", async () => {
    const f = rpcFake({ sigList: sigs(10) });
    expect(await collectSolana(["0xnot-solana"], base(f.fetchImpl))).toEqual({ ok: false, gap: "no valid Solana address" });
    expect(f.calls).toHaveLength(0);
    const res = await collectSolana([OWNER], { ...base(f.fetchImpl, { HELIUS_KEY: KEY, SOL_SAMPLE: "2" }), minSample: 1 });
    if (!res.ok) throw new Error(res.gap);
    expect(res.facts[OWNER]!.sampleSeen).toBe(2);
  });
});
