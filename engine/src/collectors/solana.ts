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
 * - обмін рахується, лише якщо власник підписав транзакцію (signer у accountKeys):
 *   чужий обмін, де адреса лише отримувач, не її торгівля;
 * - swaps точний, коли прочитано всі успішні й список не обрізаний (договір §3).
 *
 * RPC: з HELIUS_KEY https://mainnet.helius-rpc.com/?api-key=… (getSignaturesForAddress і
 * getTransaction по 1 кредиту, 4 паралельно) або SOLANA_RPC_URL (будь-який постачальник,
 * напр. Alchemy, так само 4 паралельно); без ключа публічний
 * https://api.mainnet-beta.solana.com (бюджет limits.ts: 1 запит, 300 мс): лише підписи,
 * а транзакції тільки в точному випадку (до 30 успішних), інакше swaps = null з приміткою.
 * Межа часу: після deadline − 10 с нових сторінок і транзакцій не беремо, віддаємо виміряне.
 */
import { fetchJson } from "../http.js";
import { backoffFor } from "../limits.js";
import type { SolanaFacts } from "../types.js";
import {
  addNote, type Budget, budgetFor, type CollectOptions, type Collected, errText, IN_BAND_RETRIES, inBandDelay, mapPool,
  REQUEST_TIMEOUT_MS, scrubKey, SOLANA_ADDRESS, STOPPED_EARLY,
} from "./onchain.js";

export const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";
export const HELIUS_RPC = "https://mainnet.helius-rpc.com/";
export const SIG_PAGE = 1000;
export const SIG_MAX_PAGES = 10;
export const DEFAULT_SAMPLE = 150;
/** Менша вибірка = прогалина (договір §3), крім точного випадку. */
export const MIN_SAMPLE = 50;
/**
 * Без HELIUS_KEY транзакції читаємо лише тоді, коли всі успішні вміщаються в стільки
 * запитів (точний випадок): публічний вузол дає 1 запит на 300 мс, 150 не влізли б у 45 с.
 */
export const PUBLIC_EXACT_MAX = 30;

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

/** keyed: власний вузол з ключем (повна вибірка, 4 паралельно), а не публічний. */
interface Rpc { url: string; host: string; keyed: boolean; key?: string }

/**
 * Секрет у повній адресі вузла: найдовший шматок шляху або значення параметра
 * (Helius ?api-key=…, Alchemy /v2/…, QuickNode /…/). Його вирізає scrubKey з текстів помилок.
 */
function secretOf(u: URL): string | undefined {
  const parts = [...u.pathname.split("/"), ...[...u.searchParams.values()]].filter((p) => p.length >= 8);
  return parts.sort((a, b) => b.length - a.length)[0];
}

/**
 * SOLANA_RPC_URL (повна https-адреса будь-якого постачальника) важить більше за HELIUS_KEY;
 * без обох публічний вузол.
 */
export function rpcFor(env: Record<string, string | undefined>): Rpc {
  const custom = env.SOLANA_RPC_URL?.trim();
  if (custom) {
    let u: URL | null = null;
    try { u = new URL(custom); } catch { /* не адреса: далі HELIUS_KEY або публічний */ }
    if (u?.protocol === "https:") return { url: custom, host: u.host, keyed: true, key: secretOf(u) };
  }
  const key = env.HELIUS_KEY?.trim();
  if (key) return { url: `${HELIUS_RPC}?api-key=${encodeURIComponent(key)}`, host: "mainnet.helius-rpc.com", keyed: true, key };
  return { url: PUBLIC_RPC, host: "api.mainnet-beta.solana.com", keyed: false };
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
      fetchImpl: o.fetchImpl, timeoutMs: REQUEST_TIMEOUT_MS,
      // Публічний вузол часто відповідає 429: на один повтор більше.
      retries: o.retries ?? (r.keyed ? 1 : 2), retryDelayMs: o.retryDelayMs ?? 1_000,
    });
    if (d && typeof d === "object" && "result" in d) return d.result ?? null;
    const msg = scrubKey(String(d?.error?.message ?? "відповідь без result"), r.key).slice(0, 200);
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
  transaction?: { message?: { accountKeys?: Array<string | { pubkey?: string; signer?: boolean }>; instructions?: Ix[] } };
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
 * Чи транзакція обмін власника: він її підписав, і є програма DEX у зовнішніх або вкладених
 * інструкціях чи серед адрес; інакше евристика балансів: хоч один токен прибув і хоч один убув.
 */
export function isSwapTx(tx: ParsedTx, owner: string): boolean {
  const msg = tx.transaction?.message;
  const meta = tx.meta ?? {};
  // Лише транзакції, які власник підписав сам. Рядкові ключі без signer підпису не доводять.
  const signed = (msg?.accountKeys ?? []).some((k) => typeof k === "object" && k.pubkey === owner && k.signer === true);
  if (!signed) return false;
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

/**
 * Оцінка обмінів (договір §3). Прочитано всі успішні й список не обрізаний: кількість
 * точна (sampleSwaps), навіть менше 50 і навіть 0 для порожнього гаманця. Інакше вибірка
 * менше minSample = null, а від 50: частка у вибірці × усі успішні підписи.
 */
export function estimateSwaps(sampleSeen: number, sampleSwaps: number, sigsOk: number, sigsCapped: boolean, minSample = MIN_SAMPLE): number | null {
  if (!sigsCapped && sampleSeen === sigsOk) return sampleSwaps;
  if (sampleSeen < minSample || sampleSeen === 0) return null;
  return Math.round((sampleSwaps / sampleSeen) * sigsOk);
}

type Sig = { signature?: string; err?: unknown; blockTime?: number | null };

interface AddressResult { facts: SolanaFacts[string]; notes: string[] }

async function collectAddress(address: string, r: Rpc, o: SolanaOptions, b: Budget, sampleSize: number, minSample: number): Promise<AddressResult> {
  const ro = { ...o, signal: b.signal };
  const notes: string[] = [];
  const sigs: Sig[] = [];
  let complete = false;
  let before: string | undefined;
  for (let page = 1; page <= SIG_MAX_PAGES; page++) {
    if (!b.open()) {
      if (page === 1) throw new Error(STOPPED_EARLY);
      notes.push(`sigs: ${STOPPED_EARLY}`);
      break;
    }
    let res: Sig[] | null;
    try {
      res = await rpc<Sig[]>(r, "getSignaturesForAddress", [address, { limit: SIG_PAGE, ...(before ? { before } : {}) }], ro);
      if (!Array.isArray(res)) throw new Error(`${r.host}: getSignaturesForAddress: відповідь не масив`);
    } catch (e) {
      if (o.signal?.aborted) throw e;
      if (b.stopped()) {
        if (page === 1) throw new Error(STOPPED_EARLY);
        notes.push(`sigs: ${STOPPED_EARLY}`);
        break;
      }
      // Перша сторінка: адреса не відповіла. Далі: лічба стає нижньою межею.
      if (page === 1) throw e;
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
  let picked: string[];
  if (r.keyed) {
    picked = ok.slice(0, sampleSize).map((s) => s.signature).filter((s): s is string => !!s);
  } else if (complete && ok.length <= PUBLIC_EXACT_MAX) {
    // Публічний вузол: лише точний випадок, коли всі успішні вміщаються в кілька запитів.
    picked = ok.map((s) => s.signature).filter((s): s is string => !!s);
  } else {
    picked = [];
    notes.push("swaps: not configured: HELIUS_KEY");
  }

  let cut = false;
  const verdicts = await mapPool(picked, r.keyed ? 4 : 1, async (sig) => {
    if (!b.open()) { cut = true; return undefined; }
    try {
      const tx = await rpc<ParsedTx>(r, "getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }], ro);
      return tx ? isSwapTx(tx, address) : undefined;
    } catch (e) {
      if (o.signal?.aborted) throw e;
      if (b.stopped()) cut = true;
      return undefined;
    }
  });
  if (cut) notes.push(`swaps: ${STOPPED_EARLY}`);
  const sampleSeen = verdicts.filter((v) => v !== undefined).length;
  const sampleSwaps = verdicts.filter((v) => v === true).length;

  return {
    facts: {
      sigs: sigs.length, sigsOk: ok.length, sigsCapped: !complete, firstTs,
      sampleSeen, sampleSwaps, swaps: estimateSwaps(sampleSeen, sampleSwaps, ok.length, !complete, minSample),
    },
    notes,
  };
}

/**
 * Solana-факти для адрес людини. Адреса, що не віддала навіть першої сторінки
 * підписів, потрапляє в `partial` (у фактах її немає: нулі були б вигадкою);
 * адреса з фактами може мати там пояснення null або зупинки перед межею часу.
 * Якщо не відповіла жодна адреса, повертає прогалину.
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

  const b = budgetFor({ ...o, env });
  const facts: SolanaFacts = {};
  const reasons = new Set<string>();
  await Promise.all(valid.map(async (address) => {
    try {
      const got = await collectAddress(address, r, o, b, sampleSize, minSample);
      facts[address] = got.facts;
      for (const n of got.notes) addNote(partial, address, n);
    } catch (e) {
      if (o.signal?.aborted) throw e;
      const why = scrubKey(errText(e), r.key);
      addNote(partial, address, why);
      reasons.add(why);
    }
  }));

  if (Object.keys(facts).length === 0) {
    const why = [...reasons].join("; ").slice(0, 400);
    return { ok: false, gap: r.keyed ? `Solana: ${why}` : `not configured: HELIUS_KEY; public ${r.host} failed: ${why}` };
  }
  return { ok: true, facts, ...(Object.keys(partial).length ? { partial } : {}) };
}
