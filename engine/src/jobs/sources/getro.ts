// Перенесено з NextRole (crypto-jobs-agent, scanner): src/sources/getro.ts (fetchGetro, mapIndustries,
// extractAts). Тут лише для щотижневої розвідки посилань на ATS; вакансій з Getro в базі немає.
/**
 * Умови Getro (https://www.getro.com/terms, версія 3.1, червень 2025) забороняють те, що «crawls,
 * scrapes, or spiders any page, data, or portion of or relating to the Services». Тому:
 * - щоденний скан Getro не читає зовсім;
 * - щотижнева розвідка (discover.ts) читає колекції лише з JOBS_GETRO_DISCOVERY=1 (типово вимкнено)
 *   і бере з вакансій тільки одне: де ATS роботодавця. Далі його вакансії йдуть з публічного API ATS.
 * Ризик при ввімкненні не нульовий: розвідка теж читає колекції. Рішення за власником.
 */
import { fetchJson, SourceUnavailableError, type FetchOptions } from "../../http.js";
import type { AtsProvider } from "../types.js";

interface GetroJob {
  title?: string; url?: string;
  organization?: { name?: string; industry_tags?: string[]; topics?: string[] };
}

/**
 * Галузь організації за словами самого Getro (`industry_tags`, `topics`). Колекції фондів
 * охоплюють усі галузі (у портфелі Coinbase Ventures є Notion), тож крипто лише організація,
 * про яку Getro так і каже; колекція як запас лише для організацій без жодної галузі.
 */
const CRYPTO_INDUSTRY = /blockchain|cryptocurrenc|crypto|web3|\bnft\b|defi/i;

export type OrgIndustry = "crypto" | "other" | "unknown";

export function orgIndustry(org: GetroJob["organization"]): OrgIndustry {
  const text = [...(org?.industry_tags ?? []), ...(org?.topics ?? [])].join(" ");
  if (!text.trim()) return "unknown";
  return CRYPTO_INDUSTRY.test(text) ? "crypto" : "other";
}

export interface GetroLink { url: string; company: string; industry: OrgIndustry }

const MAX_PAGES = 200;
/** Getro віддає рівно двадцять на сторінку й ігнорує `hitsPerPage`. */
const PER_PAGE = 20;

/**
 * Посилання вакансій колекції. Пауза між сторінками: Getro тротлить агресивно, і 429 посеред
 * гортання лишає прочитане (перша сторінка без відповіді означає, що колекції цього разу немає).
 */
export async function fetchGetroLinks(collectionId: number, o: FetchOptions = {}, pages = MAX_PAGES,
                                      pauseMs = 600): Promise<GetroLink[]> {
  const out: GetroLink[] = [];
  let limit = pages;
  for (let page = 0; page < limit; page++) {
    if (page > 0 && pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
    let p: { results?: { jobs?: GetroJob[]; count?: number } };
    try {
      p = await fetchJson<{ results?: { jobs?: GetroJob[]; count?: number } }>(
        `https://api.getro.com/api/v2/collections/${collectionId}/search/jobs`,
        { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ page, hitsPerPage: PER_PAGE, filters: {} }) }, o);
    } catch (e) {
      if (page > 0 && e instanceof SourceUnavailableError && e.status === 429) break;
      throw e;
    }
    const batch = p.results?.jobs ?? [];
    if (batch.length === 0) break;
    if (page === 0) {
      const count = p.results?.count;
      if (typeof count === "number" && count > 0) limit = Math.min(pages, Math.ceil(count / PER_PAGE));
    }
    for (const j of batch) {
      if (!j.url) continue;
      out.push({ url: j.url, company: j.organization?.name ?? "", industry: orgIndustry(j.organization) });
    }
  }
  return out;
}

/**
 * ATS і слаг із посилання на вакансію. Поправки 13.09.2026, кожна з живого посилання: крапка й %20
 * у слагу Ashby (`kraken.com`, `Sui%20Foundation`), вбудована форма Greenhouse (`?for=`),
 * Recruitee, європейський Lever. Teamtailor додано тут (хост буває з регіоном: `x.na.teamtailor.com`).
 */
const ATS_PATTERNS: Array<[AtsProvider, RegExp]> = [
  ["greenhouse", /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/embed\/job_app\?(?:[^#]*&)?for=([a-z0-9_-]+)/i],
  ["greenhouse", /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?!embed\/)([a-z0-9_-]+)/i],
  ["lever", /\/\/jobs\.lever\.co\/([a-z0-9_-]+)/i],
  ["lever_eu", /\/\/jobs\.eu\.lever\.co\/([a-z0-9_-]+)/i],
  ["ashby", /jobs\.ashbyhq\.com\/([a-z0-9_.%-]+?)(?:[/?#]|$)/i],
  ["workable", /apply\.workable\.com\/([a-z0-9_-]+)/i],
  ["smartrecruiters", /jobs\.smartrecruiters\.com\/([a-z0-9_-]+)/i],
  ["breezy", /\/\/([a-z0-9_-]+)\.breezy\.hr/i],
  ["rippling", /ats\.rippling\.com\/([a-z0-9_-]+)/i],
  ["personio", /\/\/([a-z0-9_-]+)\.jobs\.personio\.(?:de|com)/i],
  ["bamboohr", /\/\/([a-z0-9_-]+)\.bamboohr\.com\/careers/i],
  ["recruitee", /\/\/([a-z0-9_-]+)\.recruitee\.com\/o\//i],
  ["teamtailor", /\/\/([a-z0-9-]+(?:\.(?:na|eu))?)\.teamtailor\.com\/jobs/i],
];

export function extractAts(url: string): { provider: AtsProvider; slug: string } | null {
  for (const [provider, rx] of ATS_PATTERNS) {
    const m = rx.exec(url);
    if (!m?.[1]) continue;
    // Слаг Ashby чутливий до регістру (Sui%20Foundation): лишаємо як є, решта в нижньому.
    return { provider, slug: provider === "ashby" ? m[1] : m[1].toLowerCase() };
  }
  return null;
}
