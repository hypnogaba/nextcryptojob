// Перенесено з NextRole (написано до запуску 14.09.2026).
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Що повертає адаптер. Адаптери не кидають винятків назовні. */
export interface SourceResult<T> {
  source: string;
  ok: boolean;
  jobs: T[];
  error?: string;
  /** Джерело недоступне (блок, пейволл, 404). Це НЕ те саме, що «нічого не знайшли». */
  broken?: boolean;
  /** 429: живе, але просить прийти пізніше. Не рахується днем падіння. */
  rateLimited?: boolean;
}

/**
 * Політика вихідних адрес.
 *
 * Сканер крутиться на VPS, а адреси стрічок приходять із бази (адмінка) і
 * з чужих серверів (редиректи). Без цієї перевірки «дошка» з адресою
 * http://127.0.0.1:… або редирект на 169.254.169.254 читав би те, що
 * бачить лише сам сервер. Тому: лише http(s), лише публічні хости, і
 * кожен стрибок редиректу перевіряється заново.
 */
export class UnsafeUrlError extends Error {
  constructor(message: string) { super(message); this.name = "UnsafeUrlError"; }
}

const MAX_REDIRECTS = 3;
/** Стеля на тіло відповіді: стрічка на десятки мегабайт — уже не стрічка. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

const isPrivateV4 = (ip: string): boolean => {
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
};

const isPrivateV6 = (ip: string): boolean => {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (v === "::" || v === "::1") return true;
  if (v.startsWith("::ffff:")) { const tail = v.slice(7); return isIP(tail) === 4 ? isPrivateV4(tail) : true; }
  return /^(fc|fd|fe[89ab]|ff)/.test(v);
};

export const isPrivateIp = (ip: string): boolean =>
  isIP(ip) === 4 ? isPrivateV4(ip) : isIP(ip) === 6 ? isPrivateV6(ip) : true;

/** Чистий розбір адреси без мережі: схема, userinfo, локальні імена, IP-літерали. */
export function checkUrlShape(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new UnsafeUrlError(`не адреса: ${raw.slice(0, 120)}`); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new UnsafeUrlError(`схема ${u.protocol} заборонена`);
  if (u.username || u.password) throw new UnsafeUrlError("адреса з userinfo заборонена");
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host.endsWith(".internal") || !host.includes(".") && isIP(host) === 0) {
    throw new UnsafeUrlError(`локальний хост заборонений: ${host}`);
  }
  const literal = host.replace(/^\[|\]$/g, "");
  if (isIP(literal) && isPrivateIp(literal)) throw new UnsafeUrlError(`приватна адреса заборонена: ${host}`);
  return u;
}

export type Lookup = (host: string) => Promise<string[]>;
const realLookup: Lookup = async (host) => (await dnsLookup(host, { all: true })).map((r) => r.address);

/** Повна перевірка: форма плюс DNS — щоб публічне ім'я не вело в приватну мережу. */
export async function assertSafeUrl(raw: string, lookup: Lookup | null): Promise<URL> {
  const u = checkUrlShape(raw);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) || !lookup) return u;
  let addrs: string[];
  try { addrs = await lookup(host); } catch { throw new SourceUnavailableError(`${host}: DNS не відповів`); }
  if (addrs.length === 0) throw new SourceUnavailableError(`${host}: DNS порожній`);
  if (addrs.some(isPrivateIp)) throw new UnsafeUrlError(`${host} вказує в приватну мережу`);
  return u;
}

/** Читає тіло зі стелею замість того, щоб довіряти Content-Length. */
async function readCapped(res: Response, cap: number, url: string): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new SourceUnavailableError(`${url} віддав більше ${Math.round(cap / 1024 / 1024)} МБ`);
    }
    parts.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { buf.set(p, off); off += p.byteLength; }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

/**
 * Джерело недоступне — двері зачинені, а не кімната порожня.
 * Уся драбина, самолікування й watchdog спираються саме на цю різницю.
 */
export class SourceUnavailableError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "SourceUnavailableError";
  }
}

/**
 * Двері зачинені назавжди. 429 сюди НЕ входить: це «занадто швидко»,
 * а не «мертве» — його треба перечекати, інакше живе джерело помилково
 * потрапляє в мертві.
 */
const BROKEN = new Set([401, 402, 403, 404, 406, 410]);
export const isBrokenStatus = (s: number): boolean => BROKEN.has(s);

const CHALLENGE = ["just a moment", "attention required", "checking your browser", "enable javascript and cookies"];

/**
 * Getro прискіпливий до Accept: без нього віддає 406, і з переліком типів
 * (application/json плюс application/xml плюс зірочка) — теж 406. Приймає рівно
 * "application/json". Тому JSON і XML мають різні набори заголовків.
 */
const JSON_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "User-Agent": "NextCryptoJobBot/0.1 (+https://nextcryptojob.xyz)",
};

const XML_HEADERS: Record<string, string> = {
  Accept: "application/xml, text/xml, application/rss+xml, */*",
  "User-Agent": "NextCryptoJobBot/0.1 (+https://nextcryptojob.xyz)",
};

export interface FetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  /** DNS для перевірки хоста. Тести з підміненим fetchImpl мережі не мають — тоді null. */
  lookup?: Lookup | null;
  maxBodyBytes?: number;
}

/**
 * fetch із перевіркою адреси на кожному стрибку.
 *
 * Редиректи — вручну: стандартний follow перейшов би на будь-що, включно
 * з внутрішнім хостом, і ми б цього не побачили.
 */
export async function safeFetch(url: string, init: RequestInit, o: FetchOptions): Promise<Response> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const lookup = o.lookup === undefined ? (o.fetchImpl ? null : realLookup) : o.lookup;
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = await assertSafeUrl(current, lookup);
    const res = await fetchImpl(u.toString(), { ...init, redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop === MAX_REDIRECTS) throw new SourceUnavailableError(`${url} → забагато редиректів`);
      // Тіло редиректу нікому не потрібне; не тримаємо з'єднання.
      await res.body?.cancel().catch(() => undefined);
      current = new URL(location, u).toString();
      // Метод і тіло після редиректу не переносимо: POST у Workday — єдиний
      // не-GET, і редиректу він не очікує.
      init = { ...init, method: "GET", body: undefined };
      continue;
    }
    return res;
  }
  throw new SourceUnavailableError(`${url} → забагато редиректів`);
}

async function fetchText(url: string, init: RequestInit, o: FetchOptions, base: Record<string, string> = JSON_HEADERS): Promise<string> {
  const { timeoutMs = 25_000, retries = 2, retryDelayMs = 800, maxBodyBytes = MAX_BODY_BYTES } = o;
  let last = "невідома помилка";

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await safeFetch(url, {
        ...init,
        signal: controller.signal,
        headers: { ...base, ...(init.headers as Record<string, string> | undefined) },
      }, o);
      if (isBrokenStatus(res.status)) {
        throw new SourceUnavailableError(`${url} → ${res.status}`, res.status);
      }
      if (res.status === 429) {
        // Поважаємо Retry-After, але не чекаємо довше хвилини
        const hinted = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
        const waitMs = Math.min(
          Number.isNaN(hinted) ? retryDelayMs * 2 ** (attempt + 1) : hinted * 1000,
          60_000);
        last = `${url} → 429, чекаю ${Math.round(waitMs / 1000)} с`;
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        throw new SourceUnavailableError(`${url} → 429 після ${retries + 1} спроб`, 429);
      }
      if (!res.ok) {
        last = `${url} → ${res.status}`;
      } else {
        const text = await readCapped(res, maxBodyBytes, url);
        if (CHALLENGE.some((m) => text.slice(0, 600).toLowerCase().includes(m))) {
          throw new SourceUnavailableError(`${url} віддав сторінку-заглушку захисту`);
        }
        return text;
      }
    } catch (e) {
      if (e instanceof SourceUnavailableError) throw e;
      // Небезпечна адреса — це не «спробуй ще раз», це «ніколи».
      if (e instanceof UnsafeUrlError) throw new SourceUnavailableError(`${url}: ${e.message}`, 403);
      last = e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries && retryDelayMs > 0) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  throw new SourceUnavailableError(`${url} не відповів після повторів: ${last}`);
}

export async function fetchJson<T>(url: string, init: RequestInit = {}, o: FetchOptions = {}): Promise<T> {
  const text = await fetchText(url, init, o);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SourceUnavailableError(`${url} віддав не JSON`);
  }
}

export async function fetchXml(url: string, init: RequestInit = {}, o: FetchOptions = {}): Promise<string> {
  return fetchText(url, init, o, XML_HEADERS);
}

/** Чи відповідає адреса 2xx. Для перевірок «ожило?» — без повторів, з коротким таймаутом. */
export async function probe(url: string, o: FetchOptions = {}): Promise<boolean> {
  const { timeoutMs = 10_000 } = o;
  try {
    const res = await safeFetch(url, {
      headers: JSON_HEADERS, signal: AbortSignal.timeout(timeoutMs),
    }, o);
    await res.body?.cancel().catch(() => undefined);
    return res.ok;
  } catch {
    return false;
  }
}

/** Обгортка: збій джерела стає даними, а не винятком. */
export async function runSource<T>(source: string, fn: () => Promise<T[]>): Promise<SourceResult<T>> {
  try {
    return { source, ok: true, jobs: await fn() };
  } catch (e) {
    const rateLimited = e instanceof SourceUnavailableError && e.status === 429;
    return {
      source,
      ok: false,
      jobs: [],
      broken: e instanceof SourceUnavailableError && !rateLimited,
      rateLimited,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Обмежувач паралелізму — щоб не бомбити один провайдер сотнями запитів. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
