import { beforeEach, describe, expect, it } from "vitest";
import { __resetLimiters } from "../limits.js";
import { collectSite, discoverFeed, normalizeSite, parseFeed, parseSitemap } from "./site.js";
import { ctxWith, mockFetch, NOW, text } from "./testkit.js";

const BASE = "https://site.example.org";
const DAY = 86_400_000;
const rfc822 = (ms: number) => new Date(ms).toUTCString();   // "Thu, 10 Sep 2026 08:00:00 GMT"

const HOME = `<!doctype html><html><head><title>Test</title>
  <link rel="stylesheet" href="/s.css">
  <link rel="alternate" type="application/rss+xml" title="Blog" href="/blog/feed.xml">
  </head><body>hello</body></html>`;

// RSS 2.0 з датою на рівні каналу (не запис) і датою в CDATA.
const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Blog</title><pubDate>${rfc822(NOW - DAY)}</pubDate>
<lastBuildDate>${rfc822(NOW - DAY)}</lastBuildDate>
<item><title>One</title><pubDate>${rfc822(NOW - 5 * DAY)}</pubDate></item>
<item><title>Two</title><pubDate><![CDATA[${rfc822(NOW - 40 * DAY)}]]></pubDate></item>
<item><title>Three</title><pubDate>${rfc822(NOW - 200 * DAY)}</pubDate></item>
<item><title>No date</title></item>
</channel></rss>`;

// Atom: у кожного запису і published, і updated; рахується один раз.
const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Notes</title><updated>2026-09-11T00:00:00Z</updated>
<entry><title>A</title><published>2026-09-01T10:00:00Z</published><updated>2026-09-02T10:00:00Z</updated></entry>
<entry><title>B</title><published>2025-01-01T10:00:00Z</published><updated>2026-09-03T10:00:00Z</updated></entry>
</feed>`;

const urlset = (n: number) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${Array.from({ length: n }, (_, i) => `<url><loc>${BASE}/p/${i}</loc><image:image><image:loc>${BASE}/i/${i}.png</image:loc></image:image></url>`).join("\n")}
</urlset>`;
const INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap><loc>${BASE}/post-sitemap.xml</loc></sitemap>
<sitemap><loc><![CDATA[${BASE}/page-sitemap.xml]]></loc></sitemap>
<sitemap><loc>https://other.example.net/foreign-sitemap.xml</loc></sitemap>
<sitemap><loc>${BASE}/archive.xml.gz</loc></sitemap>
</sitemapindex>`;

const notFound = () => text("<html>404</html>", 404, "text/html");

function site(routes: Record<string, () => Response>) {
  return mockFetch((u) => (routes[u.origin + u.pathname] ?? notFound)());
}

beforeEach(() => { __resetLimiters(); });

describe("collectSite: розбір", () => {
  it("стрічка з <link rel=alternate>, карта-індекс із дочірніми картами того самого хоста", async () => {
    const { fetchImpl, calls } = site({
      [`${BASE}/`]: () => text(HOME, 200, "text/html; charset=utf-8"),
      [`${BASE}/blog/feed.xml`]: () => text(RSS, 200, "application/rss+xml"),
      [`${BASE}/sitemap.xml`]: () => text(INDEX),
      [`${BASE}/post-sitemap.xml`]: () => text(urlset(12)),
      [`${BASE}/page-sitemap.xml`]: () => text(urlset(3)),
    });
    const r = await collectSite("Site.Example.org/", ctxWith(fetchImpl));
    expect(r).toEqual({ ok: true, facts: {
      reachable: true, feedItems: 4, items90d: 2, sitemapUrls: 15,
      latestTs: Math.floor((NOW - 5 * DAY) / 1000),
    } });
    const hosts = new Set(calls.map((c) => c.url.host));
    expect(hosts).toEqual(new Set(["site.example.org"]));   // чужа і стиснена карти не качаються
  });

  it("Atom за типовим шляхом: запис рахується один раз", async () => {
    const { fetchImpl } = site({
      [`${BASE}/`]: () => text("<html><body>no links</body></html>", 200, "text/html"),
      [`${BASE}/atom.xml`]: () => text(ATOM, 200, "application/atom+xml"),
      [`${BASE}/sitemap.xml`]: () => text(urlset(7)),
    });
    const r = await collectSite(BASE, ctxWith(fetchImpl));
    expect(r).toEqual({ ok: true, facts: {
      reachable: true, feedItems: 2, items90d: 1, sitemapUrls: 7,
      latestTs: Date.UTC(2026, 8, 1, 10) / 1000,
    } });
  });

  it("SPA віддає HTML на всі шляхи: стрічки й карти немає, сайт доступний", async () => {
    const { fetchImpl } = mockFetch(() => text("<!doctype html><div id=root></div>", 200, "text/html"));
    expect(await collectSite(BASE, ctxWith(fetchImpl))).toEqual({ ok: true, facts: {
      reachable: true, feedItems: 0, items90d: 0, sitemapUrls: 0, latestTs: null } });
  });

  it("домашня сторінка не відповідає: reachable false, решту не питаємо", async () => {
    const { fetchImpl, calls } = mockFetch(() => text("oops", 500, "text/html"));
    expect(await collectSite(BASE, ctxWith(fetchImpl))).toEqual({ ok: true, facts: {
      reachable: false, feedItems: 0, items90d: 0, sitemapUrls: 0, latestTs: null } });
    expect(calls).toHaveLength(1);
  });

  it("нормалізація адреси за §2", () => {
    expect(normalizeSite("Example.COM/blog/")).toBe("https://example.com/blog");
    expect(normalizeSite("https://example.com")).toBe("https://example.com");
  });

  it("парсери: не-стрічка, RSS 1.0, sitemap без <loc> у image:loc", () => {
    expect(parseFeed("<html><body>hi</body></html>")).toBeNull();
    expect(parseFeed(`<rdf:RDF xmlns:rdf="x"><channel><items/></channel><item rdf:about="a"><dc:date>2026-09-01T00:00:00Z</dc:date></item></rdf:RDF>`))
      .toEqual({ items: 1, dates: [Date.UTC(2026, 8, 1)] });
    expect(parseSitemap(urlset(2))).toEqual({ urls: 2, children: [] });
    expect(discoverFeed(`<link href='https://feeds.example.net/x?a=1&amp;b=2' type="application/atom+xml" rel=alternate>`, BASE))
      .toBe("https://feeds.example.net/x?a=1&b=2");
    expect(discoverFeed(`<link rel="alternate" type="application/rss+xml" href="http://insecure.example.net/rss">`, BASE)).toBeNull();
  });
});

describe("collectSite: політика адрес (SSRF)", () => {
  it.each([
    ["http://site.example.org", "site: only https URLs are accepted"],
    ["https://10.0.0.1", "site: refused: URL points to a private or local address"],
    ["https://[::1]/", "site: refused: URL points to a private or local address"],
    ["https://localhost:8080", "site: refused: URL points to a private or local address"],
    ["https://metadata.internal/latest", "site: refused: URL points to a private or local address"],
    ["https://169.254.169.254/latest/meta-data/", "site: refused: URL points to a private or local address"],
    ["ftp://site.example.org", "site: only https URLs are accepted"],
  ])("%s: відмова без жодного запиту", async (url, gap) => {
    const { fetchImpl, calls } = mockFetch(() => text(HOME, 200, "text/html"));
    expect(await collectSite(url, ctxWith(fetchImpl))).toEqual({ ok: false, gap });
    expect(calls).toHaveLength(0);
  });

  it("публічне ім'я, що резолвиться в приватну мережу: відмова без запиту", async () => {
    const { fetchImpl, calls } = mockFetch(() => text(HOME, 200, "text/html"));
    const r = await collectSite(BASE, ctxWith(fetchImpl, {}, { lookup: async () => ["10.1.2.3"] }));
    expect(r).toEqual({ ok: false, gap: "site: refused: URL or its redirect points to a private or local address" });
    expect(calls).toHaveLength(0);
  });

  it("редирект домашньої сторінки на 127.0.0.1: відмова, другого стрибка немає", async () => {
    const { fetchImpl, calls } = mockFetch(() => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:9200/" } }));
    const r = await collectSite(BASE, ctxWith(fetchImpl));
    expect(r).toMatchObject({ ok: false, gap: expect.stringMatching(/^site: refused/) });
    expect(calls).toHaveLength(1);
  });

  it("стрічка з редиректом у приватну мережу просто пропускається", async () => {
    const { fetchImpl, calls } = site({
      [`${BASE}/`]: () => text(HOME, 200, "text/html"),
      [`${BASE}/blog/feed.xml`]: () => new Response(null, { status: 301, headers: { location: "http://169.254.169.254/feed" } }),
      [`${BASE}/rss.xml`]: () => text(RSS, 200, "application/rss+xml"),
    });
    const r = await collectSite(BASE, ctxWith(fetchImpl));
    expect(r).toMatchObject({ ok: true, facts: { reachable: true, feedItems: 4 } });
    expect(calls.some((c) => c.url.host === "169.254.169.254")).toBe(false);
  });

  it("нескінченне тіло: читається лише початок, збір завершується", async () => {
    let cancelled = false;
    const chunk = new TextEncoder().encode(`<url><loc>${BASE}/p</loc></url>`.repeat(1000));
    const endless = () => new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode(`<?xml version="1.0"?><urlset>`)); },
      pull(c) { c.enqueue(chunk); },
      cancel() { cancelled = true; },
    }), { status: 200, headers: { "content-type": "application/xml" } });
    const { fetchImpl } = site({ [`${BASE}/`]: () => text(HOME, 200, "text/html"), [`${BASE}/sitemap.xml`]: endless });
    const r = await collectSite(BASE, ctxWith(fetchImpl));
    expect(r.ok).toBe(true);
    const urls = r.ok ? r.facts.sitemapUrls : 0;
    expect(urls).toBeGreaterThan(1_000);
    expect(urls).toBeLessThan(5 * 1024 * 1024 / 30);   // стеля 5 МБ, а не все тіло
    expect(cancelled).toBe(true);
  });
});
