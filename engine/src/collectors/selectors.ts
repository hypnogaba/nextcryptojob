/**
 * Назви методів за 4-байтовим селектором (openchain) і розпізнавання обмінів.
 *
 * Etherscan віддає `functionName` лише для перевірених контрактів, Blockscout
 * не віддає його зовсім, тому решту селекторів розвʼязуємо через openchain.
 * Відповіді живуть у JSON-кеші на диску: селектор не змінює назви, а другий
 * запит за тим самим селектором лише палить бюджет.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fetchJson } from "../http.js";
import { errText, REQUEST_TIMEOUT_MS } from "./onchain.js";

/**
 * Назва методу, яка означає обмін. Перенесено з research/harness/collect_fast.py (SWAP_NAME)
 * з однією правкою: `execute(bytes` тепер лише Universal Router Uniswap
 * (`execute(bytes,bytes[])` і `execute(bytes,bytes[],uint256)`), а не будь-яке
 * `execute(bytes32…)`. Приймає обидва стилі назв: openchain без імен параметрів
 * і Etherscan з іменами ("execute(bytes commands,bytes[] inputs,uint256 deadline)").
 * `swapETH(uint16…` це міст Stargate, `swapOwner` заміна власника Safe: не обміни.
 */
export const SWAP_NAME =
  /swap(?!ETH\(uint16|owner)|exactinput|exactoutput|^execute\(bytes(?:\s+\w+)?,\s*bytes\[\]|fillorder|fillquote|sellto|transformerc20|unoswap/i;

export const isSwapName = (name: string | null | undefined): boolean => !!name && SWAP_NAME.test(name.trim());

export const SELECTOR = /^0x[0-9a-f]{8}$/;
export const OPENCHAIN_LOOKUP = "https://api.openchain.xyz/signature-database/v1/lookup";
/** Скільки селекторів в одному запиті до openchain. */
export const SELECTOR_BATCH = 40;

/** SELECTOR_CACHE з переданого оточення, далі з process.env, далі ./data/selectors.json. */
export const selectorCachePath = (env?: Record<string, string | undefined>): string =>
  env?.SELECTOR_CACHE?.trim() || process.env.SELECTOR_CACHE?.trim() || "./data/selectors.json";

/** Скільки вірити відповіді «openchain назви не знає»: базу поповнюють, тож за добу питаємо знову. */
export const UNKNOWN_TTL_MS = 24 * 3600_000;

/** Назва або позначка «не знає» з часом перевірки (мс). */
type Entry = string | { unknownAt: number };
type CacheFile = Record<string, Entry>;

async function readCacheFile(path: string): Promise<CacheFile> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch { return {}; }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: CacheFile = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!SELECTOR.test(k)) continue;
      if (typeof v === "string" && v) out[k] = v;
      else if (v && typeof v === "object" && Number.isFinite((v as { unknownAt?: unknown }).unknownAt)) {
        out[k] = { unknownAt: Number((v as { unknownAt: number }).unknownAt) };
      }
      // null без часу (старий формат) не беремо: вважаємо простроченим і питаємо знову.
    }
    return out;
  } catch {
    // Зіпсований файл: краще почати з порожнього кешу, ніж зупинити збір.
    return {};
  }
}

/**
 * Кеш селекторів одного файлу. Рядок = назва (назавжди: селектор не змінює назви);
 * {unknownAt} = openchain назви не знав (дійсне UNKNOWN_TTL_MS); відсутній ключ = ще не питали.
 */
class SelectorCache {
  private map: Map<string, Entry> | null = null;
  private loading: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  async ready(): Promise<Map<string, Entry>> {
    if (this.map) return this.map;
    this.loading ??= readCacheFile(this.path).then((f) => { this.map = new Map(Object.entries(f)); });
    await this.loading;
    return this.map!;
  }

  /**
   * Атомарний запис: тимчасовий файл і rename, щоб обрив посеред запису не лишив
   * пів-JSON. Перед записом зливаємо з тим, що на диску (інший процес міг додати своє).
   * Записи йдуть по черзі.
   */
  save(): Promise<void> {
    const run = async (): Promise<void> => {
      const map = await this.ready();
      const onDisk = await readCacheFile(this.path);
      for (const [k, v] of Object.entries(onDisk)) if (!map.has(k)) map.set(k, v);
      const obj: CacheFile = {};
      for (const k of [...map.keys()].sort()) obj[k] = map.get(k)!;
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(obj, null, 0) + "\n", "utf8");
      await rename(tmp, this.path);
    };
    this.writing = this.writing.then(run, run);
    return this.writing;
  }
}

const caches = new Map<string, SelectorCache>();
const cacheFor = (path: string): SelectorCache => {
  let c = caches.get(path);
  if (!c) { c = new SelectorCache(path); caches.set(path, c); }
  return c;
};

/** Лише для тестів: забути кеші в памʼяті (файли лишаються). */
export function __resetSelectorCaches(): void { caches.clear(); }

export interface ResolveOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Шлях до кешу. Типово SELECTOR_CACHE (з env, далі process.env) або ./data/selectors.json. */
  cachePath?: string;
  env?: Record<string, string | undefined>;
  /** Годинник, мс (термін придатності «не знає»). Типово Date.now. */
  now?: () => number;
  retries?: number;
  retryDelayMs?: number;
}

export interface Resolved {
  /** Селектор → назва (null: openchain не знає). Лише ті, що відомі після виклику. */
  names: Map<string, string | null>;
  /** Селектори, для яких openchain не відповів: назва невідома, а не «немає». */
  failed: Set<string>;
  /** Скільки запитів пішло в openchain (для тестів і журналу). */
  requests: number;
  error?: string;
}

type OpenchainResponse = {
  ok?: boolean;
  result?: { function?: Record<string, Array<{ name?: string }> | null> };
};

/** Розвʼязує селектори: спершу кеш, решту пачками по 40 через openchain; нове дописує в кеш. */
export async function resolveSelectors(selectors: Iterable<string>, o: ResolveOptions = {}): Promise<Resolved> {
  const cache = cacheFor(o.cachePath ?? selectorCachePath(o.env));
  const map = await cache.ready();
  const now = o.now ?? Date.now;
  const wanted = new Set<string>();
  for (const s of selectors) {
    const v = s.toLowerCase();
    if (SELECTOR.test(v)) wanted.add(v);
  }
  const names = new Map<string, string | null>();
  const need: string[] = [];
  for (const s of wanted) {
    const e = map.get(s);
    if (typeof e === "string") names.set(s, e);
    else if (e && now() - e.unknownAt < UNKNOWN_TTL_MS) names.set(s, null);
    else need.push(s);
  }
  need.sort();

  const failed = new Set<string>();
  let error: string | undefined;
  const chunks: string[][] = [];
  for (let i = 0; i < need.length; i += SELECTOR_BATCH) chunks.push(need.slice(i, i + SELECTOR_BATCH));

  await Promise.all(chunks.map(async (chunk) => {
    const url = `${OPENCHAIN_LOOKUP}?filter=true&function=${chunk.join(",")}`;
    try {
      const d = await fetchJson<OpenchainResponse>(url, { signal: o.signal },
        { fetchImpl: o.fetchImpl, retries: o.retries, retryDelayMs: o.retryDelayMs, timeoutMs: REQUEST_TIMEOUT_MS });
      const fn = d?.result?.function;
      if (d?.ok !== true || !fn || typeof fn !== "object") throw new Error("openchain відповів без result.function");
      for (const s of chunk) {
        const hits = fn[s];
        const name = Array.isArray(hits) ? hits.find((h) => typeof h?.name === "string" && h.name)?.name ?? null : null;
        map.set(s, name ?? { unknownAt: now() });
        names.set(s, name);
      }
    } catch (e) {
      if (o.signal?.aborted) throw e;
      for (const s of chunk) failed.add(s);
      error ??= `openchain: ${errText(e)}`;
    }
  }));

  if (need.length > failed.size) {
    // Кеш лише економить запити: збій диска не має зупиняти збір.
    await cache.save().catch((e: unknown) => { error ??= `кеш селекторів не записано: ${errText(e)}`; });
  }
  return { names, failed, requests: chunks.length, ...(error ? { error } : {}) };
}
