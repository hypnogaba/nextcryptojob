// Перенесено з NextRole (написано до запуску 14.09.2026).
import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { budgetKeyForUrl, limiterFor, MAX_BACKOFF_MS, NestedRunError } from "./limits.js";

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

/** IPv6 у вісім 16-бітних груп ("::" розгорнуто, IPv4 у хвості перетворено). null, якщо не розібрати. */
function v6Groups(v: string): number[] | null {
  let s = v;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const o = tail[1]!.split(".").map(Number);
    s = s.slice(0, -tail[1]!.length) + `${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

const isPrivateV6 = (ip: string): boolean => {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (v === "::" || v === "::1") return true;
  if (v.startsWith("::ffff:")) { const tail = v.slice(7); return isIP(tail) === 4 ? isPrivateV4(tail) : true; }
  const g = v6Groups(v);
  if (!g) return true;
  // Обгортки IPv4, за якими може стояти будь-яка, зокрема приватна, IPv4:
  // NAT64 64:ff9b::/96 і 64:ff9b:1::/48 (RFC 6052, 8215), 6to4 2002::/16 (RFC 3056).
  if (g[0] === 0x64 && g[1] === 0xff9b && (g[2] === 1 || g.slice(2, 6).every((x) => x === 0))) return true;
  if (g[0] === 0x2002) return true;
  // fc00::/7 (ULA), fe80::/10 (link-local), ff00::/8 (multicast).
  return (g[0]! & 0xfe00) === 0xfc00 || (g[0]! & 0xffc0) === 0xfe80 || (g[0]! & 0xff00) === 0xff00;
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

/**
 * lookup для net.connect: розвʼязує ім'я і відмовляє, якщо хоч одна адреса приватна.
 *
 * Перевірка перед запитом (assertSafeUrl) і з'єднання питають DNS окремо, і між ними
 * ім'я може почати вказувати в приватну мережу (DNS rebinding). Тому з'єднання
 * бере адреси лише звідси: сокет відкривається на ту IP, яку щойно перевірено.
 */
export function guardedLookup(resolve: Lookup): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then((addrs) => {
      const all: LookupAddress[] = addrs.map((address) => ({ address, family: isIP(address) }));
      if (all.length === 0) throw new SourceUnavailableError(`${hostname}: DNS порожній`);
      if (all.some((a) => a.family === 0 || isPrivateIp(a.address))) {
        throw new UnsafeUrlError(`${hostname} вказує в приватну мережу`);
      }
      const family = options.family === 4 || options.family === 6 ? options.family : 0;
      const fit = family ? all.filter((a) => a.family === family) : all;
      if (fit.length === 0) throw new SourceUnavailableError(`${hostname}: немає адрес IPv${family}`);
      if (options.all) callback(null, fit);
      else callback(null, fit[0]!.address, fit[0]!.family);
    }).catch((e: unknown) => {
      callback(e instanceof Error ? e : new Error(String(e)), "", 0);
    });
  };
}

/** Один пул з'єднань на функцію DNS: у роботі це завжди realLookup. */
const pinnedAgents = new WeakMap<Lookup, Agent>();

/** fetch, у якого кожне з'єднання йде лише на адресу, перевірену guardedLookup. */
function pinnedFetch(resolve: Lookup): typeof fetch {
  let agent = pinnedAgents.get(resolve);
  if (!agent) {
    agent = new Agent({ connect: { lookup: guardedLookup(resolve) } });
    pinnedAgents.set(resolve, agent);
  }
  const dispatcher = agent;
  return ((input: string | URL, init?: RequestInit) =>
    undiciFetch(input, { ...(init as object), dispatcher })) as unknown as typeof fetch;
}

/** Відмова guardedLookup приходить загорнутою в TypeError("fetch failed"); дістаємо її. */
function unsafeCause(e: unknown): UnsafeUrlError | null {
  for (let c: unknown = e, depth = 0; c instanceof Error && depth < 5; c = c.cause, depth++) {
    if (c instanceof UnsafeUrlError) return c;
  }
  return null;
}

/** Читає тіло зі стелею замість того, щоб довіряти Content-Length. */
export async function readCapped(res: Response, cap: number, shownUrl: string): Promise<string> {
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
  /** Стеля паузи бюджету після 429 (типово MAX_BACKOFF_MS): джерело, що просить години, не зупиняє інших надовго. */
  maxBackoffMs?: number;
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
 * Кожен стрибок бере слот limiterFor(budgetKeyForUrl(адреса)) і тримає його до заголовків
 * відповіді; 429 відсуває весь бюджет ще до звільнення слота. Сигнал
 * викликача знімає запит і з черги бюджету, і з мережі.
 *
 * Редиректи вручну: стандартний follow перейшов би на будь-що, включно
 * з внутрішнім хостом, і повіз би туди токени.
 */
export async function safeFetch(url: string, init: RequestInit = {}, o: FetchOptions = {}): Promise<Response> {
  // Підмінений fetchImpl (тести) мережі не має: DNS перевіряється, лише якщо тест дав lookup.
  // Справжній fetch відкриває з'єднання тільки на IP, перевірену guardedLookup, тож
  // відповідь DNS між перевіркою і з'єднанням (rebinding) нічого не змінює.
  const lookup = o.lookup === undefined ? (o.fetchImpl ? null : realLookup) : o.lookup;
  const fetchImpl = o.fetchImpl ?? (lookup ? pinnedFetch(lookup) : fetch);
  const timeoutMs = o.timeoutMs ?? 25_000;
  const userSignal = init.signal ?? undefined;
  const method = (init.method ?? "GET").toUpperCase();
  let headers = new Headers(init.headers);
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = await assertSafeUrl(current, lookup);
    const limiter = limiterFor(budgetKeyForUrl(u));
    const res = await limiter.run(async () => {
      const timeout = AbortSignal.timeout(timeoutMs);
      const r = await fetchImpl(u.toString(), {
        ...init, method, headers, redirect: "manual",
        signal: userSignal ? AbortSignal.any([userSignal, timeout]) : timeout,
      }).catch((e: unknown) => { throw unsafeCause(e) ?? e; });
      if (r.status === 429) {
        limiter.backoff(Math.min(retryAfterMs(r.headers) ?? o.backoffOn429Ms ?? 2_000, o.maxBackoffMs ?? MAX_BACKOFF_MS));
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
