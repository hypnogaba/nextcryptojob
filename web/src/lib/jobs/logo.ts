import type { JobsDb } from "@/lib/jobs-db";
import { cleanDomain, companyProfiles } from "./companies";

/**
 * Значок компанії через наш сайт (/api/logo/<domain>), а не прямо з чужого сервісу значків:
 * - браузер людини не ходить на сторонній хост, тож ні її IP, ні список компаній, які вона дивиться,
 *   нікому не йдуть, і CSP лишається img-src 'self';
 * - це не відкритий проксі: лише домен з реєстру роботодавців (companies.domain, db/jobs 0005), інакше
 *   404 без жодного запиту назовні; хост, куди йде запит, сталий (FAVICON_HOST), домен лише параметр;
 * - лише растрові картинки до MAX_BYTES: SVG з нашого походження міг би виконати скрипт;
 * - відповідь кешується в браузері й на краю Cloudflare (Cache API), тож значок однієї компанії
 *   береться назовні рідко.
 * Нема значка (сервіс не знає домену): 404, і картка лишає літеру компанії.
 */

export const FAVICON_HOST = "https://www.google.com";
export const faviconUrl = (domain: string): string => `${FAVICON_HOST}/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;

export const MAX_BYTES = 64 * 1024;
const TYPES = new Set(["image/png", "image/x-icon", "image/vnd.microsoft.icon", "image/jpeg", "image/gif", "image/webp"]);
const FETCH_TIMEOUT_MS = 5_000;

/** Тиждень у браузері й на краю: значки міняються рідко. */
const CACHE_OK = "public, max-age=604800, stale-while-revalidate=86400";
/** Нема значка: день, щоб не питати щоразу. */
const CACHE_MISS = "public, max-age=86400";

const SAFE = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  // cross-origin: значок публічний, і його показує лист добірки в поштовому клієнті (17.09).
  // same-origin ховав його скрізь, де клієнт тягне картинку напряму, а не через свій проксі.
  "Cross-Origin-Resource-Policy": "cross-origin",
};

const notFound = (cache: string | null = CACHE_MISS) =>
  new Response(null, { status: 404, headers: { ...SAFE, ...(cache ? { "Cache-Control": cache } : { "Cache-Control": "no-store" }) } });

type LogoDeps = {
  jobs: () => JobsDb;
  fetchImpl?: typeof fetch;
  /** Кеш краю (Cloudflare Cache API); у Node і тестах його немає. */
  cache?: Cache | null;
};

function edgeCache(): Cache | null {
  const c = (globalThis as { caches?: CacheStorage & { default?: Cache } }).caches;
  return c?.default ?? null;
}

async function fromUpstream(domain: string, fetchImpl: typeof fetch): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(faviconUrl(domain), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { Accept: "image/*" } });
  } catch (e) {
    console.warn(`logo: favicon fetch failed (${e instanceof Error ? e.name : "unknown"})`);
    return notFound(null);
  }
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!res.ok || !TYPES.has(type)) {
    await res.body?.cancel().catch(() => undefined);
    return notFound();
  }
  const body = await res.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > MAX_BYTES) return notFound();
  return new Response(body, { status: 200, headers: { ...SAFE, "Content-Type": type, "Cache-Control": CACHE_OK } });
}

export async function logoResponse(request: Request, raw: string, deps: LogoDeps): Promise<Response> {
  // Лише та форма, яку дає сама сторінка (logoPath): нижній регістр, без www і без іншого сміття.
  const domain = cleanDomain(raw);
  if (!domain || domain !== raw) return notFound();
  const known = (await companyProfiles(deps.jobs)).domains;
  if (!known.has(domain)) return notFound();

  const cache = deps.cache === undefined ? edgeCache() : deps.cache;
  const key = new Request(new URL(`/api/logo/${domain}`, request.url).toString(), { method: "GET" });
  const hit = cache ? await cache.match(key).catch(() => undefined) : undefined;
  if (hit) {
    // Заголовки безпеки беремо свіжі, не з кешу: значки, збережені до 17.09, несли CORP same-origin.
    const fresh = new Response(hit.body, hit);
    for (const [k, v] of Object.entries(SAFE)) fresh.headers.set(k, v);
    return fresh;
  }

  const res = await fromUpstream(domain, deps.fetchImpl ?? fetch);
  if (cache && res.headers.get("Cache-Control") !== "no-store") await cache.put(key, res.clone()).catch(() => undefined);
  return res;
}
