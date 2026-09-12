/**
 * Збирач EVM: надіслані транзакції, вік і обміни на Ethereum, Base, Arbitrum, Optimism.
 *
 * Перенесено з research/harness/collect_fast.py (etherscan_txlist, evm_chain, evm_summary)
 * з правками його слабких місць:
 * - збій посеред сторінок більше не видає обрізаний список за повний: лічба стає
 *   нижньою межею (sentCapped), вік береться окремим запитом, у `gap` пишемо причину;
 * - назва методу береться з `functionName` для кожного рядка окремо, а порожні
 *   розвʼязуються через openchain (раніше openchain питали, лише коли порожні всі);
 * - якщо openchain не відповів, обміни мережі невідомі (null), а не занижені;
 * - Blockscout теж іде сторінками по 1000: 10 000 рядків одним тілом перевищили б стелю.
 *
 * Джерела (перевірено 11–12.09.2026):
 * - Etherscan v2 з ETHERSCAN_KEY: безкоштовний ключ покриває лише Ethereum і Arbitrum
 *   ("Free API access is not supported for this chain" для Base і Optimism);
 * - Blockscout PRO з BLOCKSCOUT_KEY: https://api.blockscout.com/v2/api?chain_id=…&apikey=…
 *   (docs.blockscout.com/devs/pro-api; без ключа 402);
 * - без ключа: публічні сервери Blockscout окремої мережі, як вийде; збій = прогалина
 *   `not configured: <KEY>` з причиною.
 * Сторінка до 1000 рядків, не більше 10 сторінок: Etherscan не дає PageNo × Offset > 10 000.
 * startblock/endblock не передаємо: endblock=99999999 з Python-версії на Blockscout
 * відрізав Optimism до 34 надісланих замість 209 (живий прогін 12.09.2026).
 *
 * Межа часу (ENGINE_DEADLINE_MS, 45 с на людину): після deadline − 10 с нових сторінок
 * не беремо (sentCapped, gap "stopped early: deadline"), за 2 с до межі обриваємо запити;
 * запит 15 с і один повтор; ліміт у тілі перечікуємо не більше трьох разів (1 + 2 + 4 с).
 */
import { fetchJson } from "../http.js";
import { backoffFor } from "../limits.js";
import type { EvmChainFacts, EvmFacts } from "../types.js";
import {
  type Budget, budgetFor, type CollectOptions, type Collected, errText, IN_BAND_RETRIES, inBandDelay, normEvm,
  REQUEST_RETRIES, REQUEST_TIMEOUT_MS, scrubKey, STOPPED_EARLY,
} from "./onchain.js";
import { isSwapName, resolveSelectors, SELECTOR } from "./selectors.js";

export type EvmChain = "ethereum" | "base" | "arbitrum" | "optimism";
export const EVM_CHAINS: readonly EvmChain[] = ["ethereum", "base", "arbitrum", "optimism"];
export const CHAIN_ID: Record<EvmChain, number> = { ethereum: 1, base: 8453, arbitrum: 42161, optimism: 10 };

/** Мережі, які безкоштовний ключ Etherscan віддає. */
export const ETHERSCAN_FREE_CHAINS: ReadonlySet<EvmChain> = new Set(["ethereum", "arbitrum"]);

export const ETHERSCAN_API = "https://api.etherscan.io/v2/api";
export const BLOCKSCOUT_PRO_API = "https://api.blockscout.com/v2/api";
/** Публічні сервери без ключа. optimism.blockscout.com відповідає 301 на explorer.optimism.io. */
export const BLOCKSCOUT_INSTANCE: Record<EvmChain, string> = {
  ethereum: "https://eth.blockscout.com/api",
  base: "https://base.blockscout.com/api",
  arbitrum: "https://arbitrum.blockscout.com/api",
  optimism: "https://explorer.optimism.io/api",
};

export const PAGE_SIZE = 1000;
export const MAX_PAGES = 10;

export interface EvmOptions extends CollectOptions {
  /** Шлях до кешу селекторів (типово SELECTOR_CACHE або ./data/selectors.json). */
  selectorCachePath?: string;
}

type Source = EvmChainFacts["source"];

interface Endpoint {
  source: Source;
  base: string;
  /** Параметри мережі й ключа, що йдуть перед рештою. */
  fixed: Record<string, string>;
  key?: string;
  /** Якого ключа бракує, коли йдемо на публічний сервер. */
  missing?: string;
}

export function endpointFor(chain: EvmChain, env: Record<string, string | undefined>): Endpoint {
  const es = env.ETHERSCAN_KEY?.trim();
  const bs = env.BLOCKSCOUT_KEY?.trim();
  const id = String(CHAIN_ID[chain]);
  if (es && ETHERSCAN_FREE_CHAINS.has(chain)) {
    return { source: "etherscan", base: ETHERSCAN_API, fixed: { chainid: id, apikey: es }, key: es };
  }
  if (bs) return { source: "blockscout", base: BLOCKSCOUT_PRO_API, fixed: { chain_id: id, apikey: bs }, key: bs };
  return {
    source: "blockscout", base: BLOCKSCOUT_INSTANCE[chain], fixed: {},
    missing: ETHERSCAN_FREE_CHAINS.has(chain) ? "ETHERSCAN_KEY" : "BLOCKSCOUT_KEY",
  };
}

function txlistUrl(ep: Endpoint, address: string, page: number, offset: number, sort: "asc" | "desc"): string {
  const u = new URL(ep.base);
  for (const [k, v] of Object.entries(ep.fixed)) u.searchParams.set(k, v);
  u.searchParams.set("module", "account");
  u.searchParams.set("action", "txlist");
  u.searchParams.set("address", address);
  // Без startblock/endblock: Blockscout чесно обрізає за endblock, а звичне 99999999
  // на Optimism (блок ~156 млн) і Arbitrum (~499 млн) відкидало всі свіжі транзакції.
  u.searchParams.set("page", String(page));
  u.searchParams.set("offset", String(offset));
  u.searchParams.set("sort", sort);
  return u.toString();
}

export type TxRow = {
  hash?: string; from?: string; timeStamp?: string; isError?: string; txreceipt_status?: string;
  methodId?: string; functionName?: string; input?: string;
};
type ApiResponse = { status?: string; message?: string; result?: unknown; error?: string };

const RATE_LIMIT = /rate limit|too many requests/i;
/** Денний ліміт перечікувати марно: до півночі він не мине. */
const DAILY_LIMIT = /daily/i;

/**
 * Одна сторінка txlist. Масив у result = рядки (зокрема "No transactions found" з []).
 * Ліміт у тілі (Etherscan: 200 і "Max rate limit reached") відсуває весь бюджет
 * через backoffFor і повторює ту саму сторінку.
 */
async function fetchRows(url: string, ep: Endpoint, o: EvmOptions, b: Budget): Promise<TxRow[]> {
  const base = o.rateLimitBackoffMs ?? 1_000;
  for (let attempt = 0; ; attempt++) {
    const d = await fetchJson<ApiResponse>(url, { signal: b.signal },
      { fetchImpl: o.fetchImpl, retries: o.retries ?? REQUEST_RETRIES, retryDelayMs: o.retryDelayMs, timeoutMs: REQUEST_TIMEOUT_MS });
    if (Array.isArray(d?.result)) return d.result as TxRow[];
    const msg = scrubKey(String((typeof d?.result === "string" && d.result) || d?.message || d?.error || "відповідь без result"), ep.key);
    if (RATE_LIMIT.test(msg) && !DAILY_LIMIT.test(msg) && attempt < IN_BAND_RETRIES) {
      backoffFor(url, inBandDelay(base, attempt));
      continue;
    }
    throw new Error(`${hostOf(ep)}: ${msg.slice(0, 200)}`);
  }
}

const hostOf = (ep: Endpoint): string => new URL(ep.base).hostname;
const ts = (r: TxRow | undefined): number | null => {
  const n = Number(r?.timeStamp);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const methodOf = (r: TxRow): string => (r.methodId || (r.input ?? "").slice(0, 10) || "0x").toLowerCase();

interface ChainRaw {
  facts: Omit<EvmChainFacts, "swaps">;
  /** Успішні надіслані: селектор і назва від джерела (порожня, якщо джерело не знає). */
  okSent: Array<{ method: string; name: string }>;
}

/** Межа часу настала раніше, ніж мережа віддала хоч сторінку. */
class StoppedEarly extends Error {
  constructor() { super(STOPPED_EARLY); this.name = "StoppedEarly"; }
}

/** Мережа однієї адреси: сторінки txlist, лічба, вік. Кидає, якщо не відповіла вже перша сторінка. */
async function collectChain(address: string, ep: Endpoint, o: EvmOptions, b: Budget): Promise<ChainRaw> {
  const rows: TxRow[] = [];
  let complete = false;
  let partial: string | undefined;
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (!b.open()) {
      if (page === 1) throw new StoppedEarly();
      partial = STOPPED_EARLY;
      break;
    }
    let got: TxRow[];
    try {
      got = await fetchRows(txlistUrl(ep, address, page, PAGE_SIZE, "desc"), ep, o, b);
    } catch (e) {
      if (o.signal?.aborted) throw e;
      if (b.stopped()) {
        if (page === 1) throw new StoppedEarly();
        partial = STOPPED_EARLY;
        break;
      }
      if (page === 1) throw e;
      partial = `partial: page ${page} failed, counts are a lower bound (${scrubKey(errText(e), ep.key)})`;
      break;
    }
    rows.push(...got);
    if (got.length < PAGE_SIZE) { complete = true; break; }
  }
  // Нова транзакція між запитами зсуває сторінки: той самий рядок міг прийти двічі.
  const seen = new Set<string>();
  const unique = rows.filter((r) => {
    if (!r.hash) return true;
    if (seen.has(r.hash)) return false;
    seen.add(r.hash);
    return true;
  });

  let firstTs: number | null = null;
  if (complete) {
    for (const r of unique) {
      const t = ts(r);
      if (t !== null && (firstTs === null || t < firstTs)) firstTs = t;
    }
  } else if (b.open()) {
    // Найстаріша транзакція за межами 10 000 рядків: один рядок за зростанням.
    try {
      firstTs = ts((await fetchRows(txlistUrl(ep, address, 1, 1, "asc"), ep, o, b))[0]);
    } catch (e) {
      if (o.signal?.aborted) throw e;
      firstTs = null;
    }
  }

  const sent = unique.filter((r) => (r.from ?? "").toLowerCase() === address);
  const okSent = sent
    .filter((r) => (r.isError ?? "0") === "0" && r.txreceipt_status !== "0")
    .map((r) => ({ method: methodOf(r), name: (r.functionName ?? "").trim() }));
  const facts: Omit<EvmChainFacts, "swaps"> = {
    sent: sent.length, sentCapped: !complete, firstTs, source: ep.source,
    ...(partial ? { gap: partial } : {}),
  };
  return { facts, okSent };
}

type Names = { names: Map<string, string | null>; failed: Set<string>; error?: string };

/** openchain для селекторів без назви. Не встиг до межі = назви невідомі (swaps null), а не падіння. */
async function lookupNames(unnamed: Set<string>, o: EvmOptions, env: Record<string, string | undefined>, b: Budget): Promise<Names> {
  if (unnamed.size === 0) return { names: new Map(), failed: new Set() };
  const stopped = (): Names => ({ names: new Map(), failed: new Set(unnamed), error: STOPPED_EARLY });
  if (b.signal.aborted) {
    if (o.signal?.aborted) throw o.signal.reason;
    return stopped();
  }
  try {
    return await resolveSelectors(unnamed, {
      fetchImpl: o.fetchImpl, signal: b.signal, cachePath: o.selectorCachePath, env, now: o.now,
      retries: o.retries ?? REQUEST_RETRIES, retryDelayMs: o.retryDelayMs,
    });
  } catch (e) {
    if (o.signal?.aborted) throw e;
    return stopped();
  }
}

const failedChain = (source: Source, gap: string): EvmChainFacts =>
  ({ sent: null, sentCapped: false, firstTs: null, swaps: null, source, gap });

/**
 * EVM-факти для адрес людини. Кожна пара (адреса, мережа) іде паралельно через бюджети
 * limits.ts; мережа, що не відповіла, отримує `gap`, решта мереж адреси лишаються.
 * Якщо не відповіло жодної мережі жодної адреси, повертає прогалину.
 */
export async function collectEvm(addresses: readonly string[], o: EvmOptions = {}): Promise<Collected<EvmFacts>> {
  const env = o.env ?? process.env;
  const { valid, invalid } = normEvm(addresses);
  const partialAddr: Record<string, string> = {};
  for (const a of invalid) partialAddr[a] = "not an EVM address";
  if (valid.length === 0) {
    return invalid.length ? { ok: false, gap: "no valid EVM address" } : { ok: true, facts: {} };
  }

  const b = budgetFor({ ...o, env });
  const jobs = valid.flatMap((address) => EVM_CHAINS.map((chain) => ({ address, chain, ep: endpointFor(chain, env) })));
  const raw = await Promise.all(jobs.map(async (j) => {
    try {
      return { ...j, raw: await collectChain(j.address, j.ep, o, b), gap: null };
    } catch (e) {
      if (o.signal?.aborted) throw e;
      if (e instanceof StoppedEarly || b.stopped()) return { ...j, raw: null, gap: STOPPED_EARLY };
      const why = scrubKey(errText(e), j.ep.key);
      const gap = j.ep.missing ? `not configured: ${j.ep.missing}; public ${hostOf(j.ep)} failed: ${why}` : why;
      return { ...j, raw: null, gap };
    }
  }));

  // Назви методів, яких джерело не дало: один прохід openchain на всі мережі.
  const unnamed = new Set<string>();
  for (const r of raw) {
    if (!r.raw) continue;
    for (const t of r.raw.okSent) if (!t.name && SELECTOR.test(t.method)) unnamed.add(t.method);
  }
  const resolved = await lookupNames(unnamed, o, env, b);

  const facts: EvmFacts = {};
  let anyOk = false;
  const reasons = new Set<string>();
  for (const r of raw) {
    const perAddr = (facts[r.address] ??= {});
    if (!r.raw) {
      const gap = r.gap ?? "no answer";
      perAddr[r.chain] = failedChain(r.ep.source, gap);
      reasons.add(`${r.chain}: ${gap}`);
      continue;
    }
    anyOk = true;
    let swaps: number | null = 0;
    for (const t of r.raw.okSent) {
      if (t.name) { if (isSwapName(t.name)) swaps++; continue; }
      if (resolved.failed.has(t.method)) { swaps = null; break; }
      if (isSwapName(resolved.names.get(t.method))) swaps++;
    }
    const chainFacts: EvmChainFacts = { ...r.raw.facts, swaps };
    if (swaps === null) {
      const note = `swaps unknown: ${resolved.error ?? "openchain did not answer"}`;
      chainFacts.gap = chainFacts.gap ? `${chainFacts.gap}; ${note}` : note;
    }
    perAddr[r.chain] = chainFacts;
  }

  if (!anyOk) return { ok: false, gap: `EVM: no chain answered (${[...reasons].join("; ").slice(0, 600)})` };
  return { ok: true, facts, ...(invalid.length ? { partial: partialAddr } : {}) };
}

