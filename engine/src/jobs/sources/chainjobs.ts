// ChainJobs (https://chainjobs.io): відкритий JSON усіх їхніх крипто-вакансій, без ключа, CORS відкритий.
// Дані під CC BY 4.0, і у відповіді самі пишуть умову: «link back to chainjobs.io where you surface
// this data». Тому кожна вакансія звідси має підпис «via chainjobs.io» (сайт, лист, Telegram:
// jobVia за джерелом рядка, бо адреса веде до роботодавця, а не на chainjobs.io), а сторінка /sources
// називає ліцензію з посиланням. `apply_url` роботодавця йде в базу як є.
//
// ChainJobs сам зібраний з публічних ATS (08.10.2026: 3 476 вакансій, 210 компаній, Greenhouse/Ashby/Lever
// головно), тож більшість його вакансій ми вже читаємо напряму. Пряма версія завжди перемагає:
//   1. адреса веде на дошку ATS з нашого реєстру → геть (її читає скан компанії);
//   2. компанію (brandKey) реєстр уже знає → геть (Coinbase, Ripple: їхні сторінки вакансій на
//      власному домені, але це та сама дошка Greenhouse);
//   3. та сама компанія + назва, що й у вакансії ATS цього ж скану → prepare.ts лишає ATS (CHAINJOBS
//      програє рівність, richness).
// Виміряно 08.10: після 1-2 лишається ~430 з 3 476, з них 194 Block (геть: Block у реєстрі з фільтром назв).
import { brandKey } from "../../digest/clean.js";
import { fetchJson, type FetchOptions } from "../../http.js";
import type { Company, RawJob } from "../types.js";
import { extractAts } from "./getro.js";

export const CHAINJOBS_SOURCE = "aggregator:chainjobs";
export const CHAINJOBS_FEED = "https://chainjobs.io/api/jobs.json";

export interface ChainJobsJob {
  id?: string;
  title?: string;
  company?: string;
  apply_url?: string;
  location?: string | null;
  remote?: boolean;
  date_posted?: string | null;
  first_seen?: string | null;
}

const iso = (v: string | null | undefined): string | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** Що реєстр уже читає: дошки ATS (провайдер:слаг у нижньому регістрі) і бренди компаній. */
export function registryIndex(companies: readonly Company[]): { boards: Set<string>; brands: Set<string> } {
  return {
    boards: new Set(companies.map((c) => `${c.provider}:${c.atsSlug.toLowerCase()}`)),
    brands: new Set(companies.map((c) => brandKey(c.name)).filter(Boolean)),
  };
}

/** Вакансії ChainJobs, яких немає в прямих джерелах реєстру (правила 1-2 вище). */
export function parseChainJobs(jobs: readonly ChainJobsJob[], companies: readonly Company[]): RawJob[] {
  const known = registryIndex(companies);
  const out: RawJob[] = [];
  for (const j of jobs) {
    const url = j.apply_url?.trim();
    const title = j.title?.trim();
    const company = j.company?.trim();
    if (!url || !title || !company || !/^https?:\/\//i.test(url)) continue;
    const ats = extractAts(url);
    if (ats && known.boards.has(`${ats.provider}:${ats.slug.toLowerCase()}`)) continue;
    if (known.brands.has(brandKey(company))) continue;
    out.push({
      url, company, title,
      location: j.location?.trim() || null,
      remote: j.remote === true,
      postedAt: iso(j.date_posted) ?? iso(j.first_seen),
      source: CHAINJOBS_SOURCE,
      // id з адреси (ids.ts), не з їхнього номера: та сама адреса з іншого джерела дає той самий id,
      // і prepare.ts лишає одну.
      crypto: true,
    });
  }
  return out;
}

export async function fetchChainJobs(companies: readonly Company[], o: FetchOptions = {}): Promise<RawJob[]> {
  const body = await fetchJson<{ jobs?: ChainJobsJob[] }>(CHAINJOBS_FEED, {}, o);
  return parseChainJobs(Array.isArray(body.jobs) ? body.jobs : [], companies);
}
