import { checkUrlShape, safeFetch, UnsafeUrlError } from "../http.js";
import type { Fetched, SiteFacts } from "../types.js";
import { collect, DAY_MS, fetchOpts, GapError, nowMs, type CollectorContext } from "./context.js";

/**
 * Сайт людини: чи відповідає, скільки текстів у стрічці і наскільки свіжих, скільки адрес у sitemap.
 *
 * Адресу задає сама людина, тому: лише https, лише публічні хости (safeFetch перевіряє кожен
 * стрибок редиректу і відкриває з'єднання тільки на перевірену IP), стеля на тіло і таймаут
 * на кожен запит. Відмова політики адрес дає прогалину, а не «сайт недоступний».
 */
export const FEED_PATHS = ["/feed", "/rss.xml", "/feed.xml", "/atom.xml", "/index.xml", "/rss"];
const HOME_BYTES = 512 * 1024;       // для пошуку <link rel="alternate"> досить початку сторінки
const FEED_BYTES = 2 * 1024 * 1024;
const SITEMAP_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 12_000;
const MAX_CHILD_SITEMAPS = 5;

const HEADERS = {
  Accept: "text/html, application/xhtml+xml, application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8",
  "User-Agent": "NextCryptoJobBot/0.1 (+https://nextcryptojob.xyz)",
};

/** §2: https + хост нижнім регістром + шлях без кінцевого "/". Без схеми вважаємо https. */
export function normalizeSite(input: string): string {
  const raw = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let u: URL;
  try { u = new URL(withScheme); } catch { throw new GapError("not a URL"); }
  if (u.protocol !== "https:") throw new GapError("only https URLs are accepted");
  try {
    checkUrlShape(u.toString());
  } catch (e) {
    if (e instanceof UnsafeUrlError) throw new GapError("refused: URL points to a private or local address");
    throw e;
  }
  return `https://${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
}

/** Перші maxBytes тіла; решту не качаємо. */
async function readHead(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      const take = value.subarray(0, Math.min(value.byteLength, maxBytes - total));
      parts.push(take);
      total += take.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { buf.set(p, off); off += p.byteLength; }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

type Got = { ok: boolean; text: string };

/** GET через safeFetch. Небезпечна адреса летить далі як UnsafeUrlError; решта збоїв дає ok:false. */
async function get(url: string, maxBytes: number, ctx: CollectorContext): Promise<Got> {
  let res: Response;
  try {
    res = await safeFetch(url, { headers: HEADERS, signal: ctx.signal }, fetchOpts(ctx, { timeoutMs: TIMEOUT_MS }));
  } catch (e) {
    if (ctx.signal?.aborted || e instanceof UnsafeUrlError) throw e;
    return { ok: false, text: "" };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, text: "" };
  }
  try {
    return { ok: true, text: await readHead(res, maxBytes) };
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    return { ok: false, text: "" };
  }
}

/** Та сама get, але небезпечна адреса (редирект стрічки в приватну мережу) просто пропускається. */
const getQuiet = (url: string, maxBytes: number, ctx: CollectorContext): Promise<Got> =>
  get(url, maxBytes, ctx).catch((e: unknown) => {
    if (e instanceof UnsafeUrlError) return { ok: false, text: "" };
    throw e;
  });

/** Адреса стрічки з <link rel="alternate" type="application/rss+xml|atom+xml" href="…">. */
export function discoverFeed(html: string, base: string): string | null {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attr = (name: string): string | undefined =>
      new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(1).find((v) => v !== undefined);
    if (!/\balternate\b/i.test(attr("rel") ?? "")) continue;
    if (!/application\/(rss|atom)\+xml/i.test(attr("type") ?? "")) continue;
    const href = attr("href");
    if (!href) continue;
    try {
      const u = new URL(href.replace(/&amp;/g, "&"), `${base}/`);
      if (u.protocol === "https:") return u.toString();
    } catch { /* зіпсований href: шукаємо далі */ }
  }
  return null;
}

const DATE_TAGS = ["pubDate", "published", "dc:date", "updated"];

function itemDate(block: string): number | null {
  for (const tag of DATE_TAGS) {
    const m = new RegExp(`<${tag}\\b[^>]*>\\s*(?:<!\\[CDATA\\[)?\\s*([^<\\]]+?)\\s*(?:\\]\\]>)?\\s*</${tag}>`, "i").exec(block);
    if (!m) continue;
    const t = Date.parse(m[1]!);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

/** RSS 2.0 / RSS 1.0 / Atom: кількість записів і дата кожного. null, якщо це не стрічка. */
export function parseFeed(xml: string): { items: number; dates: number[] } | null {
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(xml)) return null;
  const items = (xml.match(/<(item|entry)[\s>]/gi) ?? []).length;
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? [];
  const dates = blocks.map(itemDate).filter((t): t is number => t !== null);
  return { items, dates };
}

/** Кількість <loc> у urlset; для sitemapindex: адреси дочірніх карт. */
export function parseSitemap(xml: string): { urls: number; children: string[] } {
  if (/<urlset[\s>]/i.test(xml)) return { urls: (xml.match(/<loc>/gi) ?? []).length, children: [] };
  if (/<sitemapindex[\s>]/i.test(xml)) {
    const children = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)/gi)].map((m) => m[1]!.replace(/&amp;/g, "&"));
    return { urls: 0, children };
  }
  return { urls: 0, children: [] };
}

async function sitemapUrls(base: string, ctx: CollectorContext): Promise<number> {
  const root = await getQuiet(`${base}/sitemap.xml`, SITEMAP_BYTES, ctx);
  if (!root.ok) return 0;
  const top = parseSitemap(root.text);
  if (top.children.length === 0) return top.urls;
  // Лише карти того самого хоста і не стиснені: чужі адреси з карти не качаємо.
  const host = new URL(base).host;
  const children = top.children.filter((c) => {
    try { const u = new URL(c); return u.protocol === "https:" && u.host === host && !u.pathname.endsWith(".gz"); } catch { return false; }
  }).slice(0, MAX_CHILD_SITEMAPS);
  const counts = await Promise.all(children.map(async (c) => {
    const r = await getQuiet(c, SITEMAP_BYTES, ctx);
    return r.ok ? parseSitemap(r.text).urls : 0;
  }));
  return counts.reduce((a, b) => a + b, 0);
}

async function feedStats(base: string, homeHtml: string, ctx: CollectorContext): Promise<{ items: number; dates: number[] }> {
  const discovered = discoverFeed(homeHtml, base);
  const candidates = [...new Set([...(discovered ? [discovered] : []), ...FEED_PATHS.map((p) => base + p)])];
  // Кандидати разом: бюджет хоста сам обмежує паралельність, а таймаут не множиться на шість.
  const parsed = await Promise.all(candidates.map(async (c) => {
    const r = await getQuiet(c, FEED_BYTES, ctx);
    return r.ok ? parseFeed(r.text) : null;
  }));
  return parsed.find((p) => p !== null && p.items > 0) ?? { items: 0, dates: [] };
}

export async function collectSite(url: string, ctx: CollectorContext): Promise<Fetched<SiteFacts>> {
  return collect("site", ctx, async () => {
    const base = normalizeSite(url);
    let home: Got;
    try {
      home = await get(base, HOME_BYTES, ctx);
    } catch (e) {
      if (e instanceof UnsafeUrlError) throw new GapError("refused: URL or its redirect points to a private or local address");
      throw e;
    }
    if (!home.ok) return { reachable: false, feedItems: 0, items90d: 0, sitemapUrls: 0, latestTs: null };

    const [feed, urls] = await Promise.all([feedStats(base, home.text, ctx), sitemapUrls(base, ctx)]);
    const since = nowMs(ctx) - 90 * DAY_MS;
    return {
      reachable: true,
      feedItems: feed.items,
      items90d: feed.dates.filter((t) => t > since).length,
      sitemapUrls: urls,
      // Секунди Unix, як firstTs у фактах гаманців.
      latestTs: feed.dates.length ? Math.floor(Math.max(...feed.dates) / 1000) : null,
    };
  });
}
