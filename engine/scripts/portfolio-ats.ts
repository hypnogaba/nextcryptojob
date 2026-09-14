/**
 * Роботодавці з публічної сторінки портфеля фонду, чия дошка вакансій на Consider (умови Consider
 * забороняють збір, тож дошку не читаємо): сторінка портфеля на сайті самого фонду → сайт кожної
 * компанії → її ATS (sources/careers.ts resolveCompanySite) → перевірка живою відповіддю API ATS.
 * Разовий інструмент для реєстру (db/jobs/seed/boards-companies-2026-09-14.json); у роботі сканера
 * не бере участі. Нічого не пише в базу.
 *
 *   npx tsx scripts/portfolio-ats.ts <fund-slug> <portfolio-url> [--out <file>]
 */
import { writeFileSync } from "node:fs";
import { fetchXml } from "../src/http.js";
import { mapLimit } from "../src/jobs/run.js";
import { ATS } from "../src/jobs/sources/ats.js";
import { resolveCompanySite } from "../src/jobs/sources/careers.js";

/** Хости, що не є сайтами компаній портфеля (соцмережі, блоги, сам фонд, інструменти). */
const NOT_COMPANY = /(^|\.)(twitter|x|linkedin|medium|youtube|youtu|github|discord|discord\.gg|t|telegram|instagram|facebook|substack|mirror|apple|google|notion|consider|getro|typeform|calendly|wikipedia|spotify|podcasts|bit|linktr|vimeo|tiktok|reddit|warpcast|farcaster|jobs|boards|app\.junipersquare)\.(com|me|org|io|gg|xyz|ly|ee|co)$/i;

export interface PortfolioLink { name: string; site: string }

/** Посилання на сайти компаній зі сторінки портфеля: назва з тексту, alt чи aria-label. */
export function portfolioLinks(html: string, fundHost: string): PortfolioLink[] {
  const out = new Map<string, PortfolioLink>();
  const fund = fundHost.replace(/^www\./, "").split(".").slice(-2).join(".");
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]{0,20000}?)<\/a>/gi)) {
    const attrs = m[1]!;
    const href = /\bhref\s*=\s*["'](https?:\/\/[^"']+)["']/i.exec(attrs)?.[1];
    if (!href) continue;
    let u: URL;
    try { u = new URL(href); } catch { continue; }
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host.endsWith(fund) || NOT_COMPANY.test(host)) continue;
    const inner = m[2]!;
    const name = (/\baria-label\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]
      ?? inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
      ?? "") || /\balt\s*=\s*["']([^"']+)["']/i.exec(inner)?.[1] || /\btitle\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] || "";
    const key = host.split(".").slice(-2).join(".");
    const clean = name.replace(/\s*(logo|website|visit|↗|→)\s*$/i, "").trim().slice(0, 80);
    const prev = out.get(key);
    if (!prev || (!prev.name && clean)) out.set(key, { name: clean, site: `${u.protocol}//${u.hostname}/` });
  }
  return [...out.values()];
}

export interface PortfolioHit { fund: string; portfolio: string; name: string; site: string; provider: string; slug: string; careersPage: string; open: number }

async function main(argv: string[]): Promise<void> {
  const [fund, url] = argv;
  const i = argv.indexOf("--out");
  const outFile = i >= 0 ? argv[i + 1] : undefined;
  if (!fund || !url) throw new Error("usage: portfolio-ats.ts <fund-slug> <portfolio-url> [--out <file>]");
  const html = await fetchXml(url, {}, { retries: 1 });
  const links = portfolioLinks(html, new URL(url).hostname);
  console.error(`${fund}: ${links.length} company sites on ${url}`);
  const hits: PortfolioHit[] = [];
  const misses: PortfolioLink[] = [];
  await mapLimit(links, 6, async (l) => {
    const r = await resolveCompanySite(l.site, { retries: 0 });
    if (!r) { misses.push(l); return; }
    try {
      const jobs = await ATS[r.hit.provider](r.hit.slug, l.name || r.hit.slug, { retries: 1 });
      hits.push({ fund, portfolio: url, name: l.name, site: l.site, provider: r.hit.provider, slug: r.hit.slug, careersPage: r.from, open: jobs.length });
    } catch (e) {
      console.error(`  ${l.site}: ${r.hit.provider}:${r.hit.slug} did not answer (${e instanceof Error ? e.message.slice(0, 80) : e})`);
    }
  });
  console.error(`${fund}: ${hits.length} with a live public ATS, ${misses.length} without`);
  const out = JSON.stringify({ fund, portfolio: url, checked: new Date().toISOString(), hits, misses }, null, 1);
  if (outFile) writeFileSync(outFile, out); else console.log(out);
}

if (process.argv[1]?.endsWith("portfolio-ats.ts")) {
  main(process.argv.slice(2)).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
