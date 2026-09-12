// Перенесено з NextRole (написано до запуску 14.09.2026).
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { limiterFor, MAX_BACKOFF_MS, NestedRunError } from "./limits.js";

/**
 * Політика вихідних адрес.
 *
 * Engine крутиться на VPS, а частину адрес (сайт, стрічка, редиректи)
 * задає кандидат або чужий сервер. Без цієї перевірки адреса
 * http://127.0.0.1:… або редирект на 169.254.169.254 читала б те, що
 * бачить лише сам сервер. Тому: лише http(s), лише публічні хости, і
 * кожен стрибок редиректу перевіряється заново.
 */
export class UnsafeUrlError extends Error {
  constructor(message: string) { super(message); this.name = "UnsafeUrlError"; }
}

const MAX_REDIRECTS = 3;
/** Стеля на тіло відповіді: відповідь на десятки мегабайт уже не відповідь API. */
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

/** Параметри запиту, чиї значення не можна показувати в помилках і логах. */
const SECRET_PARAM = /api[-_]?key|key|token|secret/i;

/**
 * Адреса для помилок і логів: origin і шлях, решта параметрів як є,
 * значення ключів і токенів замасковані. Ключі джерел живуть у рядку
 * запиту (Etherscan, Helius), тож без цього вони потрапили б у gap_reason.
 */
export function redact(raw: string | URL): string {
  let u: URL;
  try { u = new URL(String(raw)); } catch { return String(raw).split(/[?#]/)[0]!.slice(0, 120); }
  if (u.origin === "null") return u.protocol;
  const out = new URL(u.origin + u.pathname);
  for (const [k, v] of u.searchParams) out.searchParams.append(k, SECRET_PARAM.test(k) ? "***" : v);
  return out.toString();
}

/** Прибирає з тексту чужої помилки значення ключів, що були в адресі. */
function scrub(text: string, raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { return text; }
  let out = text;
  for (const [k, v] of u.searchParams) {
    if (!v || !SECRET_PARAM.test(k)) continue;
    out = out.split(v).join("***").split(encodeURIComponent(v)).join("***");
  }
  return out;
}

/** Чистий розбір адреси без мережі: схема, userinfo, локальні імена, IP-літерали. */
export function checkUrlShape(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new UnsafeUrlError(`не адреса: ${redact(raw)}`); }
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

/** Повна перевірка: форма плюс DNS, щоб публічне ім'я не вело в приватну мережу. */
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
async function readCapped(res: Response, cap: number, shownUrl: string): Promise<string> {
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
      throw new SourceUnavailableError(`${shownUrl} віддав більше ${Math.round(cap / 1024 / 1024)} МБ`);
    }
    parts.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { buf.set(p, off); off += p.byteLength; }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

const discard = (res: Response): Promise<void> => res.body?.cancel().catch(() => undefined) ?? Promise.resolve();

/**
 * Джерело недоступне: двері зачинені, а не кімната порожня.
 * Збирач на цій різниці пише прогалину (gap_reason), а не нуль.
 */
export class SourceUnavailableError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "SourceUnavailableError";
  }
}

/**
 * Двері зачинені назавжди. 429 сюди НЕ входить: це «занадто швидко»,
 * а не «мертве», і його треба перечекати.
 */
const BROKEN = new Set([401, 402, 403, 404, 406, 410]);
export const isBrokenStatus = (s: number): boolean => BROKEN.has(s);

const CHALLENGE = ["just a moment", "attention required", "checking your browser", "enable javascript and cookies"];

/**
 * Частина API прискіплива до Accept: перелік типів із зірочкою дає 406.
 * Тому JSON і XML мають окремі набори заголовків.
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
  /** Таймаут одного стрибка: відлік іде від отримання слота бюджету, а не від постановки в чергу. */
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  /** DNS для перевірки хоста. Тести з підміненим fetchImpl мережі не мають, тоді null. */
  lookup?: Lookup | null;
  maxBodyBytes?: number;
  /** Пауза для всього бюджету після 429 без Retry-After. fetchJson і fetchXml ставлять її самі, зростаючою. */
  backoffOn429Ms?: number;
}

/** Retry-After у секундах або як дата. null, якщо заголовка немає чи він незрозумілий. */
function retryAfterMs(h: Headers): number | null {
  const v = h.get("retry-after")?.trim();
  if (!v) return null;
  const seconds = Number(v);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);
const CREDENTIAL_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);

/** Заголовки без облікових даних: на чужий origin вони не їдуть. */
function withoutCredentials(h: Headers): Headers {
  const out = new Headers();
  h.forEach((v, k) => { if (!CREDENTIAL_HEADERS.has(k) && !/key|token/i.test(k)) out.set(k, v); });
  return out;
}

function mergeHeaders(base: Record<string, string>, extra: RequestInit["headers"]): Headers {
  const out = new Headers(base);
  new Headers(extra).forEach((v, k) => out.set(k, v));
  return out;
}

/**
 * fetch із перевіркою адреси на кожному стрибку і з бюджетом запитів.
 *
 * Кожен стрибок бере слот limiterFor(хост) і тримає його до заголовків
 * відповіді; 429 відсуває весь бюджет ще до звільнення слота. Сигнал
 * викликача знімає запит і з черги бюджету, і з мережі.
 *
 * Редиректи вручну: стандартний follow перейшов би на будь-що, включно
 * з внутрішнім хостом, і повіз би туди токени.
 */
export async function safeFetch(url: string, init: RequestInit = {}, o: FetchOptions = {}): Promise<Response> {
  const fetchImpl = o.fetchImpl ?? fetch;
  // TODO(збирачі, SSRF): з підміненим fetchImpl перевірка DNS вимикається, а зі справжнім
  // між перевіркою і з'єднанням DNS може відповісти інакше (rebinding). Прив'язати
  // з'єднання до перевіреної IP через undici dispatcher.
  const lookup = o.lookup === undefined ? (o.fetchImpl ? null : realLookup) : o.lookup;
  const timeoutMs = o.timeoutMs ?? 25_000;
  const userSignal = init.signal ?? undefined;
  const method = (init.method ?? "GET").toUpperCase();
  let headers = new Headers(init.headers);
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = await assertSafeUrl(current, lookup);
    const limiter = limiterFor(u.hostname);
    const res = await limiter.run(async () => {
      const timeout = AbortSignal.timeout(timeoutMs);
      const r = await fetchImpl(u.toString(), {
        ...init, method, headers, redirect: "manual",
        signal: userSignal ? AbortSignal.any([userSignal, timeout]) : timeout,
      });
      if (r.status === 429) {
        limiter.backoff(Math.min(retryAfterMs(r.headers) ?? o.backoffOn429Ms ?? 2_000, MAX_BACKOFF_MS));
      }
      return r;
    }, { signal: userSignal });

    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop === MAX_REDIRECTS) throw new SourceUnavailableError(`${redact(url)} → забагато редиректів`);
      // Тіло редиректу нікому не потрібне; не тримаємо з'єднання.
      await discard(res);
      const next = new URL(location, u);
      const sameOrigin = next.origin === u.origin;
      if (!SAFE_METHODS.has(method) && (!sameOrigin || (res.status !== 307 && res.status !== 308))) {
        // Мовчки зробити з POST GET або повезти тіло на інший сервер: обидва варіанти гірші за відмову.
        throw new SourceUnavailableError(
          `${redact(url)}: ${method} перенаправлено (${res.status}) на ${redact(next)}; ` +
          "запит із тілом іде далі лише за 307/308 у межах того самого origin", res.status);
      }
      if (!sameOrigin) headers = withoutCredentials(headers);
      current = next.toString();
      continue;
    }
    return res;
  }
  throw new SourceUnavailableError(`${redact(url)} → забагато редиректів`);
}

async function fetchText(url: string, init: RequestInit, o: FetchOptions, base: Record<string, string> = JSON_HEADERS): Promise<string> {
  const { retries = 2, retryDelayMs = 800, maxBodyBytes = MAX_BODY_BYTES } = o;
  const shown = redact(url);
  const signal = init.signal ?? undefined;
  const headers = mergeHeaders(base, init.headers);
  let last = "невідома помилка";

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await safeFetch(url, { ...init, headers },
        { ...o, backoffOn429Ms: o.backoffOn429Ms ?? retryDelayMs * 2 ** (attempt + 1) });
      if (isBrokenStatus(res.status)) {
        await discard(res);
        throw new SourceUnavailableError(`${shown} → ${res.status}`, res.status);
      }
      if (res.status === 429) {
        await discard(res);
        // Паузу вже поставив safeFetch на весь бюджет; наступна спроба стане в чергу за нею.
        if (attempt < retries) { last = `${shown} → 429`; continue; }
        throw new SourceUnavailableError(`${shown} → 429 після ${retries + 1} спроб`, 429);
      }
      if (!res.ok) {
        await discard(res);
        last = `${shown} → ${res.status}`;
      } else {
        const text = await readCapped(res, maxBodyBytes, shown);
        const html = (res.headers.get("content-type") ?? "").toLowerCase().includes("text/html");
        if (html && CHALLENGE.some((m) => text.slice(0, 600).toLowerCase().includes(m))) {
          throw new SourceUnavailableError(`${shown} віддав сторінку-заглушку захисту`);
        }
        return text;
      }
    } catch (e) {
      if (e instanceof SourceUnavailableError || e instanceof NestedRunError) throw e;
      // Небезпечна адреса означає не «спробуй ще раз», а «ніколи».
      if (e instanceof UnsafeUrlError) throw new SourceUnavailableError(`${shown}: ${e.message}`, 403);
      // Скасував викликач: повтор був би проти його волі.
      if (signal?.aborted) throw e;
      last = scrub(e instanceof Error ? e.message : String(e), url);
    }
    if (attempt < retries && retryDelayMs > 0) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  throw new SourceUnavailableError(`${shown} не відповів після повторів: ${last}`);
}

export async function fetchJson<T>(url: string, init: RequestInit = {}, o: FetchOptions = {}): Promise<T> {
  const text = await fetchText(url, init, o);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SourceUnavailableError(`${redact(url)} віддав не JSON`);
  }
}

export async function fetchXml(url: string, init: RequestInit = {}, o: FetchOptions = {}): Promise<string> {
  return fetchText(url, init, o, XML_HEADERS);
}

/** Чи відповідає адреса 2xx. Без повторів, з коротким таймаутом. */
export async function probe(url: string, o: FetchOptions = {}): Promise<boolean> {
  try {
    const res = await safeFetch(url, { headers: JSON_HEADERS }, { ...o, timeoutMs: o.timeoutMs ?? 10_000 });
    await discard(res);
    return res.ok;
  } catch {
    return false;
  }
}
