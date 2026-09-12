/**
 * Збирач Solana: підписи, вік і обміни вибіркою.
 *
 * Перенесено з research/harness/sol_sample.py з правками його слабких місць:
 * - збій посеред сторінок підписів не видає обрізаний список за повний: sigsCapped = true
 *   (лічба = нижня межа), вік невідомий;
 * - blockTime буває null: вік береться з найранішого непорожнього;
 * - евристика балансів рахує сирі `amount` (uiAmount буває null) і сумує кілька
 *   рахунків того самого токена в одного власника (раніше останній перезаписував);
 * - програми DEX шукаються і в адресах із таблиць (meta.loadedAddresses);
 * - swaps = null при вибірці менше 50, як велить договір §3 (раніше число за будь-якої).
 *
 * RPC: з HELIUS_KEY https://mainnet.helius-rpc.com/?api-key=… (getSignaturesForAddress і
 * getTransaction по 1 кредиту, 4 паралельно); без ключа публічний
 * https://api.mainnet-beta.solana.com (бюджет limits.ts: 1 запит, 300 мс), по одному.
 */
import { fetchJson } from "../http.js";
import { backoffFor } from "../limits.js";
import type { SolanaFacts } from "../types.js";
import { type CollectOptions, type Collected, errText, IN_BAND_RETRIES, inBandDelay, mapPool, SOLANA_ADDRESS } from "./onchain.js";

export const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";
export const HELIUS_RPC = "https://mainnet.helius-rpc.com/";
export const SIG_PAGE = 1000;
export const SIG_MAX_PAGES = 10;
export const DEFAULT_SAMPLE = 150;
/** Менша вибірка = прогалина (договір §3). */
export const MIN_SAMPLE = 50;

/** Програми DEX: у зовнішніх чи вкладених інструкціях або серед адрес транзакції = обмін. */
export const DEX_PROGRAMS: ReadonlySet<string> = new Set([
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", // Jupiter v6
  "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB", // Jupiter v4
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM v4
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // Raydium CLMM
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", // Raydium CPMM
  "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj", // Raydium LaunchLab
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", // Orca Whirlpool
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", // Pump.fun
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", // PumpSwap
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", // Meteora DLMM
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB", // Meteora pools
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", // Meteora DAMM v2
  "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN", // Meteora DBC
]);

export interface SolanaOptions extends CollectOptions {
  /** Скільки останніх успішних транзакцій читати (типово SOL_SAMPLE або 150). */
  sampleSize?: number;
  /** Нижня межа вибірки, з якої swaps стає числом (типово 50, договір §3). */
  minSample?: number;
}

interface Rpc { url: string; host: string; helius: boolean }

export function rpcFor(env: Record<string, string | undefined>): Rpc {
  const key = env.HELIUS_KEY?.trim();
  if (key) return { url: `${HELIUS_RPC}?api-key=${encodeURIComponent(key)}`, host: "mainnet.helius-rpc.com", helius: true };
  return { url: PUBLIC_RPC, host: "api.mainnet-beta.solana.com", helius: false };
}

type RpcResponse<T> = { result?: T; error?: { code?: number; message?: string } };
const RPC_RATE_LIMIT = /rate.?limit|too many requests/i;

/** Один виклик JSON-RPC. result: null = «немає такого» (getTransaction), це не помилка. */
async function rpc<T>(r: Rpc, method: string, params: unknown[], o: CollectOptions): Promise<T | null> {
  const base = o.rateLimitBackoffMs ?? 1_000;
  for (let attempt = 0; ; attempt++) {
    const d = await fetchJson<RpcResponse<T>>(r.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: o.signal,
    }, {
      fetchImpl: o.fetchImpl, timeoutMs: 30_000,
      // Публічний вузол часто відповідає 429: повторів більше.
      retries: o.retries ?? (r.helius ? 2 : 4), retryDelayMs: o.retryDelayMs ?? (r.helius ? 800 : 1_500),
    });
    if (d && typeof d === "object" && "result" in d) return d.result ?? null;
    const msg = String(d?.error?.message ?? "відповідь без result").slice(0, 200);
    const code = d?.error?.code;
    if ((code === 429 || code === -32429 || RPC_RATE_LIMIT.test(msg)) && attempt < IN_BAND_RETRIES) {
      backoffFor(r.url, inBandDelay(base, attempt));
      continue;
    }
    throw new Error(`${r.host}: ${method}: ${msg}`);
  }
}

// Форма відповіді getTransaction з encoding=jsonParsed (лише те, що читаємо).
type Ix = { programId?: string };
type TokenBalance = { mint?: string; owner?: string; uiTokenAmount?: { amount?: string } };
export type ParsedTx = {
  transaction?: { message?: { accountKeys?: Array<string | { pubkey?: string }>; instructions?: Ix[] } };
  meta?: {
    innerInstructions?: Array<{ instructions?: Ix[] }> | null;
    preTokenBalances?: TokenBalance[] | null;
    postTokenBalances?: TokenBalance[] | null;
    loadedAddresses?: { writable?: string[]; readonly?: string[] } | null;
  } | null;
};

/** Сума сирих кількостей токенів власника за mint. */
function ownerBalances(list: TokenBalance[] | null | undefined, owner: string): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const b of list ?? []) {
    if (b.owner !== owner || !b.mint) continue;
    let v: bigint;
    try { v = BigInt(b.uiTokenAmount?.amount ?? "0"); } catch { continue; }
    out.set(b.mint, (out.get(b.mint) ?? 0n) + v);
  }
  return out;
}

/**
 * Чи транзакція обмін: програма DEX у зовнішніх або вкладених інструкціях чи серед адрес;
 * інакше евристика балансів власника: хоч один токен прибув і хоч один убув.
 */
export function isSwapTx(tx: ParsedTx, owner: string): boolean {
  const msg = tx.transaction?.message;
  const meta = tx.meta ?? {};
  if ((msg?.instructions ?? []).some((ix) => ix.programId !== undefined && DEX_PROGRAMS.has(ix.programId))) return true;
  for (const inner of meta.innerInstructions ?? []) {
    if ((inner.instructions ?? []).some((ix) => ix.programId !== undefined && DEX_PROGRAMS.has(ix.programId))) return true;
  }
  const keys = (msg?.accountKeys ?? []).map((k) => (typeof k === "string" ? k : k.pubkey ?? ""));
  keys.push(...(meta.loadedAddresses?.writable ?? []), ...(meta.loadedAddresses?.readonly ?? []));
  if (keys.some((k) => DEX_PROGRAMS.has(k))) return true;

  const pre = ownerBalances(meta.preTokenBalances, owner);
  const post = ownerBalances(meta.postTokenBalances, owner);
  let up = false, down = false;
  for (const mint of new Set([...pre.keys(), ...post.keys()])) {
    const d = (post.get(mint) ?? 0n) - (pre.get(mint) ?? 0n);
    if (d > 0n) up = true; else if (d < 0n) down = true;
  }
  return up && down;
}

/** Оцінка обмінів: частка у вибірці × усі успішні підписи; замала вибірка = null. */
export function estimateSwaps(sampleSeen: number, sampleSwaps: number, sigsOk: number, minSample = MIN_SAMPLE): number | null {
  if (sampleSeen < minSample || sampleSeen === 0) return null;
  return Math.round((sampleSwaps / sampleSeen) * sigsOk);
}

type Sig = { signature?: string; err?: unknown; blockTime?: number | null };

async function collectAddress(address: string, r: Rpc, o: SolanaOptions, sampleSize: number, minSample: number): Promise<SolanaFacts[string]> {
  const sigs: Sig[] = [];
  let complete = false;
  let before: string | undefined;
  for (let page = 1; page <= SIG_MAX_PAGES; page++) {
    let res: Sig[] | null;
    try {
      res = await rpc<Sig[]>(r, "getSignaturesForAddress", [address, { limit: SIG_PAGE, ...(before ? { before } : {}) }], o);
      if (!Array.isArray(res)) throw new Error(`${r.host}: getSignaturesForAddress: відповідь не масив`);
    } catch (e) {
      // Перша сторінка: адреса не відповіла. Далі: лічба стає нижньою межею.
      if (page === 1 || o.signal?.aborted) throw e;
      break;
    }
    sigs.push(...res);
    const last = res.at(-1)?.signature;
    if (res.length < SIG_PAGE || !last) { complete = true; break; }
    before = last;
  }

  let firstTs: number | null = null;
  if (complete) {
    for (const s of sigs) {
      const t = s.blockTime;
      if (typeof t === "number" && t > 0 && (firstTs === null || t < firstTs)) firstTs = t;
    }
  }

  const ok = sigs.filter((s) => s.err === null || s.err === undefined);
  const picked = ok.slice(0, sampleSize).map((s) => s.signature).filter((s): s is string => !!s);
  const verdicts = await mapPool(picked, r.helius ? 4 : 1, async (sig) => {
    try {
      const tx = await rpc<ParsedTx>(r, "getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }], o);
      return tx ? isSwapTx(tx, address) : undefined;
    } catch (e) {
      if (o.signal?.aborted) throw e;
      return undefined;
    }
  });
  const sampleSeen = verdicts.filter((v) => v !== undefined).length;
  const sampleSwaps = verdicts.filter((v) => v === true).length;

  return {
    sigs: sigs.length, sigsOk: ok.length, sigsCapped: !complete, firstTs,
    sampleSeen, sampleSwaps, swaps: estimateSwaps(sampleSeen, sampleSwaps, ok.length, minSample),
  };
}

/**
 * Solana-факти для адрес людини. Адреса, що не віддала навіть першої сторінки
 * підписів, потрапляє в `partial` (у фактах її немає: нулі були б вигадкою).
 * Якщо так з усіма, повертає прогалину.
 */
export async function collectSolana(addresses: readonly string[], o: SolanaOptions = {}): Promise<Collected<SolanaFacts>> {
  const env = o.env ?? process.env;
  const r = rpcFor(env);
  const envSample = Number(env.SOL_SAMPLE);
  const sampleSize = Math.max(0, Math.floor(o.sampleSize ?? (Number.isFinite(envSample) && envSample > 0 ? envSample : DEFAULT_SAMPLE)));
  const minSample = o.minSample ?? MIN_SAMPLE;

  const valid = [...new Set(addresses.map((a) => a.trim()).filter((a) => SOLANA_ADDRESS.test(a)))];
  const partial: Record<string, string> = {};
  for (const a of addresses) if (!SOLANA_ADDRESS.test(a.trim())) partial[a] = "not a Solana address";
  if (valid.length === 0) return Object.keys(partial).length ? { ok: false, gap: "no valid Solana address" } : { ok: true, facts: {} };

  const facts: SolanaFacts = {};
  const reasons = new Set<string>();
  await Promise.all(valid.map(async (address) => {
    try {
      facts[address] = await collectAddress(address, r, o, sampleSize, minSample);
    } catch (e) {
      if (o.signal?.aborted) throw e;
      const why = errText(e);
      partial[address] = why;
      reasons.add(why);
    }
  }));

  if (Object.keys(facts).length === 0) {
    const why = [...reasons].join("; ").slice(0, 400);
    return { ok: false, gap: r.helius ? `Solana: ${why}` : `not configured: HELIUS_KEY; public ${r.host} failed: ${why}` };
  }
  return { ok: true, facts, ...(Object.keys(partial).length ? { partial } : {}) };
}
