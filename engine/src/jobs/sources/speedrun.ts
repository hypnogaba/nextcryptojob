// Перенесено з NextRole (crypto-jobs-agent, scanner): src/sources/speedrun.ts, лише крипто-частина.
/**
 * Мережа талантів a16z speedrun, `speedrun-talent-network.com`. Джерело саме пропонує себе
 * машині: сторінка `/developers` («Reads are open and unauthenticated»), версійований REST
 * `/api/v1`, OpenAPI. Ми не обходимо захист і не розбираємо верстку.
 *
 * Беремо лише крипто-компанії мережі: галузь «Crypto/Web3» у списку компаній плюс учасники
 * колекції `crypto-web3` (13.09.2026: 36 компаній, 223 відкриті ролі). Ролі кожної з деталі
 * компанії (`/companies/{slug}`): один запит на компанію, усі її ролі разом.
 *
 * `?source=` вони просять передавати: параметр ставить `utm_source=<агент>&utm_medium=agent`
 * на посилання вакансій, тож наші переходи їм видно. Тому utm тут НЕ зрізаємо.
 */
import { fetchJson, type FetchOptions } from "../../http.js";
import { MAX_YEARLY, MIN_YEARLY } from "../pay.js";
import type { RawJob } from "../types.js";

const BASE = "https://speedrun-talent-network.com/api/v1";

/** Ім'я джерела в jobs_cache.source. */
export const SPEEDRUN_SOURCE = "aggregator:speedrun";

/** Наше ім'я для атрибуції (`?source=`). */
const AGENT = "nextcryptojob";

const HOURS_PER_YEAR = 2080;

const iso = (v: unknown): string | null => {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * Сума в річну за періодом, який назвало джерело. Порожній період означає рік (серед 156
 * виміряних без періоду найменша 71 000); малі числа приходять із чесно названим `hour`.
 */
export function yearlyComp(value: number | null | undefined, period: string | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return null;
  const p = (period ?? "").toLowerCase();
  const factor = p === "hour" ? HOURS_PER_YEAR : p === "month" ? 12 : p === "week" ? 52 : 1;
  const n = Math.round(value * factor);
  return n >= MIN_YEARLY && n <= MAX_YEARLY ? n : null;
}

interface ApiJob {
  id?: string; title?: string; url?: string; location?: string | null;
  workplace_type?: string | null; employment_type?: string | null; remote?: boolean; stealth?: boolean;
  comp_min?: number | null; comp_max?: number | null; comp_currency?: string | null; comp_period?: string | null;
  published_at?: string | null;
}

/** `remote` і `workplace_type` іноді сперечаються; перемагає конкретніше, тип робочого місця. */
export function isRemoteRole(j: Pick<ApiJob, "remote" | "workplace_type">): boolean {
  const w = (j.workplace_type ?? "").toLowerCase();
  if (w === "onsite" || w === "hybrid") return false;
  if (w === "remote") return true;
  return j.remote === true;
}

/** Позначка переходу, як її ставить сам список ролей; адресу з utm не чіпаємо взагалі. */
export function withAgentUtm(url: string): string {
  if (/[?&]utm_source=/.test(url)) return url;
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("speedrun-talent-network.com")) return url;
    u.searchParams.set("utm_source", AGENT);
    u.searchParams.set("utm_medium", "agent");
    return u.toString();
  } catch {
    return url;
  }
}

/** Приховані компанії (`stealth`) відкидаємо: за маскою «Stealth» людині нікуди піти. */
export function toRawJob(j: ApiJob, company: string): RawJob | null {
  if (!j.url || !j.title || !company) return null;
  if (j.stealth) return null;
  return {
    url: withAgentUtm(j.url), company, title: j.title, location: j.location ?? null,
    remote: isRemoteRole(j), postedAt: iso(j.published_at),
    salaryMin: yearlyComp(j.comp_min, j.comp_period), salaryMax: yearlyComp(j.comp_max, j.comp_period),
    salaryCurrency: j.comp_currency ?? null, source: SPEEDRUN_SOURCE, crypto: true,
  };
}

const q = (params: Record<string, string | number>): string =>
  new URLSearchParams({ ...params, source: AGENT } as Record<string, string>).toString();

/** Галузь «Crypto/Web3» (словник мережі, 38 міток, звірено 05.09). */
const CRYPTO_INDUSTRY = /crypto|web3|blockchain|\bnft\b|\bdefi\b/i;

export const isCryptoIndustry = (labels: readonly string[] | undefined): boolean =>
  CRYPTO_INDUSTRY.test((labels ?? []).join(" "));

/** Крипто-компанії мережі: slug → назва. Список компаній по сто на сторінку плюс колекція. */
export async function fetchSpeedrunCryptoCompanies(o: FetchOptions = {}, maxPages = 20): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let limit = maxPages;
  for (let page = 0; page < limit; page++) {
    const p = await fetchJson<{ companies?: Array<{ slug?: string; name?: string; industries?: string[] }>; total_pages?: number }>(
      `${BASE}/companies?${q({ page })}`, {}, o);
    const batch = p.companies ?? [];
    if (batch.length === 0) break;
    if (page === 0 && typeof p.total_pages === "number" && p.total_pages > 0) limit = Math.min(maxPages, p.total_pages);
    for (const c of batch) if (c.slug && c.name && isCryptoIndustry(c.industries)) out.set(c.slug, c.name);
  }
  try {
    const p = await fetchJson<{ collection?: { members?: Array<{ slug?: string; name?: string }> } }>(
      `${BASE}/collections/crypto-web3?${q({})}`, {}, o);
    for (const m of p.collection?.members ?? []) if (m.slug && m.name && !out.has(m.slug)) out.set(m.slug, m.name);
  } catch { /* колекція лише доповнює список за галуззю */ }
  return out;
}

/** Усі відкриті ролі однієї компанії, не старші за `days`. */
export async function fetchSpeedrunCompanyJobs(slug: string, name: string, days: number, o: FetchOptions = {},
                                               now: Date = new Date()): Promise<RawJob[]> {
  const p = await fetchJson<{ company?: { name?: string; jobs?: ApiJob[] } }>(
    `${BASE}/companies/${encodeURIComponent(slug)}?${q({})}`, {}, o);
  const cutoff = now.getTime() - days * 86_400_000;
  const company = p.company?.name ?? name;
  const out: RawJob[] = [];
  for (const j of p.company?.jobs ?? []) {
    const t = j.published_at ? new Date(j.published_at).getTime() : NaN;
    if (Number.isFinite(t) && t < cutoff) continue;
    const raw = toRawJob(j, company);
    if (raw) out.push(raw);
  }
  return out;
}

/** Усі крипто-компанії мережі з їхніми ролями. Одна компанія не відповіла: решта від цього не залежить. */
export async function fetchSpeedrunCrypto(days: number, o: FetchOptions = {}, now: Date = new Date()): Promise<RawJob[]> {
  const companies = await fetchSpeedrunCryptoCompanies(o);
  const out: RawJob[] = [];
  const seen = new Set<string>();
  for (const [slug, name] of companies) {
    try {
      for (const j of await fetchSpeedrunCompanyJobs(slug, name, days, o, now)) {
        if (seen.has(j.url)) continue;
        seen.add(j.url);
        out.push(j);
      }
    } catch { /* одна компанія не відповіла */ }
  }
  return out;
}

// ── розвідка: справжній ATS роботодавця ──────────────────────
/** Ідентифікатор першої відкритої ролі компанії: вхід до її ATS. */
export async function firstJobId(companySlug: string, o: FetchOptions = {}): Promise<string | null> {
  const p = await fetchJson<{ company?: { jobs?: Array<{ id?: string }> } }>(
    `${BASE}/companies/${encodeURIComponent(companySlug)}?${q({})}`, {}, o);
  return p.company?.jobs?.find((j) => j.id)?.id ?? null;
}

/**
 * Адреса подачі ролі (`apply.url`): це вже `job-boards.greenhouse.io/…` чи `jobs.ashbyhq.com/…`,
 * тобто точне знання, де ATS роботодавця, а не вгадування слага за назвою.
 */
export async function fetchApplyUrl(jobId: string, o: FetchOptions = {}): Promise<string | null> {
  const p = await fetchJson<{ job?: { apply?: { url?: string } }; apply?: { url?: string } }>(
    `${BASE}/jobs/${encodeURIComponent(jobId)}?${q({})}`, {}, o);
  const u = p.job?.apply?.url ?? p.apply?.url;
  return typeof u === "string" && /^https?:\/\//i.test(u) ? u : null;
}
