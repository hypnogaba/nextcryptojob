// Пул вакансій для добірки: кеш NextRole (лише читання) і живі вакансії компаній у нашій базі.
// Пул читається один раз на прогін для всіх людей, чия година настала, і лише якщо такі є.
import type { Db } from "../pipeline/db.js";
import { companyKey, isNonCryptoCompany } from "./clean.js";
import type { JobsDb } from "./jobs-db.js";
import { type DigestJob, isRemoteLocation, type JobSalary } from "./match.js";
import { parseRoles, titleRoles } from "./roles.js";

/**
 * Скільки днів тому NextRole мав бачити вакансію на дошці. Кеш нічого не видаляє,
 * а скан щодня оновлює fetched_at у кожної побаченої; хто випав з вікна, той знятий
 * з дошки. Три доби, як у самого NextRole (scanner/src/digest.ts): запас на день без скану.
 */
export const LIVE_WINDOW_DAYS = 3;
/** Свіжість за датою публікації (match.ts FRESH_DAYS); тут лише щоб не тягнути старе з бази. */
export const POSTED_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * Один запит на прогін. Індексу на fetched_at у jobs_cache немає навмисно (NextRole
 * зняв його 04.09: кожне оновлення fetched_at сканом множило записи, а записи D1
 * в тисячу разів дорожчі за читання), тож це повний прохід по таблиці: близько
 * 57 тис. rows_read на прогін, і лише в години, коли комусь пора добірка.
 * Час у jobs_cache пише NextRole як ISO з 'T' і 'Z', тому межі теж ISO.
 */
export const NEXTROLE_POOL_SQL = `SELECT id, url, company, company_key, title, location, remote, salary_min, salary_max,
       salary_currency, tags, posted_at, fetched_at, country, dedupe_key
  FROM jobs_cache
 WHERE fetched_at >= ? AND tags LIKE '%"web3"%' AND (posted_at IS NULL OR posted_at >= ?)`;

type NrRow = {
  id: string; url: string; company: string; company_key: string; title: string; location: string | null;
  remote: number; salary_min: number | null; salary_max: number | null; salary_currency: string | null;
  tags: string; posted_at: string | null; fetched_at: string; country: string | null; dedupe_key: string | null;
};

type CompanyRow = {
  id: string; company_id: string; company_name: string; title: string; roles: string; remote_mode: string;
  city: string | null; country: string | null; salary_min: number | null; salary_max: number | null;
  salary_currency: string | null; salary_period: string | null; published_at: string | null;
};

/** Дата з бази: ISO ('…T…Z') або SQLite ('YYYY-MM-DD HH:MM:SS', UTC за договором §9). */
export function parseDbTime(v: string | null | undefined): number | null {
  if (!v) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(v) ? `${v.replace(" ", "T")}Z` : v;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function tagsOf(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch { return []; }
}

function salaryOf(min: number | null, max: number | null, currency: string | null, period: string | null): JobSalary | null {
  if (min === null && max === null) return null;
  return { min, max, currency: currency ? currency.toUpperCase() : null, period: period === "month" ? "month" : "year" };
}

export type PoolStats = {
  /** Рядків повернуто з jobs_cache (після SQL). */
  fetched: number;
  /** Скільки лишилось після чистки (роль, не-крипто компанія чи назва). */
  kept: number;
  dropped: { tag: number; company: number; title: number };
  rowsRead: number | null;
  d1Ms: number | null;
  wallMs: number;
};

/** Рядок кешу NextRole → вакансія пулу; null, якщо це не крипто або не наша роль. */
export function nextroleJob(r: NrRow): { job: DigestJob } | { drop: "tag" | "company" | "title" } {
  const tags = tagsOf(r.tags);
  // Тег web3 перевіряє вже SQL (LIKE); тут ще раз точно, бо LIKE бачить і підрядок.
  if (!tags.includes("web3")) return { drop: "tag" };
  if (isNonCryptoCompany(r.company_key, r.company)) return { drop: "company" };
  const roles = titleRoles(r.title, tags);
  if (roles.length === 0) return { drop: "title" };
  return {
    job: {
      ref: `nr:${r.id}`, source: "nextrole", id: r.id, title: r.title.trim(), company: r.company.trim(),
      companyKey: r.company_key || companyKey(r.company), url: r.url, location: r.location?.trim() || null,
      placeText: r.location, remote: isRemoteLocation(r.remote === 1, r.location), country: r.country,
      salary: salaryOf(r.salary_min, r.salary_max, r.salary_currency, null),
      postedAt: parseDbTime(r.posted_at), seenAt: parseDbTime(r.fetched_at), dedupeKey: r.dedupe_key, roles,
    },
  };
}

export async function loadNextrolePool(jobs: JobsDb, now: Date): Promise<{ jobs: DigestJob[]; stats: PoolStats }> {
  const live = new Date(now.getTime() - LIVE_WINDOW_DAYS * DAY_MS).toISOString();
  const posted = new Date(now.getTime() - POSTED_WINDOW_DAYS * DAY_MS).toISOString();
  const res = await jobs.select<NrRow>(NEXTROLE_POOL_SQL, [live, posted]);
  const out: DigestJob[] = [];
  const dropped = { tag: 0, company: 0, title: 0 };
  for (const r of res.rows) {
    const x = nextroleJob(r);
    if ("job" in x) out.push(x.job); else dropped[x.drop]++;
  }
  return {
    jobs: out,
    stats: { fetched: res.rows.length, kept: out.length, dropped, rowsRead: res.meta.rowsRead, d1Ms: res.meta.durationMs, wallMs: res.wallMs },
  };
}

/** Посилання на вакансію компанії: публічна сторінка на сайті (специфікація CRM 5.6). */
export function companyJobUrl(siteUrl: string, id: string): string {
  return `${siteUrl.replace(/\/+$/, "")}/jobs/${encodeURIComponent(id)}`;
}

export function companyJob(r: CompanyRow, siteUrl: string): DigestJob | null {
  const roles = parseRoles(r.roles);
  if (roles.length === 0) return null;
  const modes = r.remote_mode.split(",").map((m) => m.trim());
  const remote = modes.includes("remote");
  const city = modes.includes("city") ? r.city?.trim() || null : null;
  const location = [remote ? "Remote" : null, city].filter(Boolean).join(" or ") || null;
  return {
    ref: `co:${r.id}`, source: "company", id: r.id, title: r.title.trim(), company: r.company_name.trim(),
    companyKey: companyKey(r.company_name), url: companyJobUrl(siteUrl, r.id), location, placeText: city, remote,
    country: r.country, salary: salaryOf(r.salary_min, r.salary_max, r.salary_currency, r.salary_period),
    postedAt: parseDbTime(r.published_at), seenAt: null, dedupeKey: null, roles,
  };
}

/** Живі вакансії компаній (company_jobs_live, 0004/0012). Без подання (база без 0003/0004) → порожньо. */
export async function loadCompanyPool(db: Db, siteUrl: string, log: (l: string) => void): Promise<DigestJob[]> {
  let rows: CompanyRow[];
  try {
    rows = await db.query<CompanyRow>(
      `SELECT id, company_id, company_name, title, roles, remote_mode, city, country, salary_min, salary_max,
              salary_currency, salary_period, published_at
         FROM company_jobs_live`);
  } catch (e) {
    if (e instanceof Error && /no such table/i.test(e.message)) {
      log("digest: company_jobs_live missing (0003/0004 not applied), company jobs skipped");
      return [];
    }
    throw e;
  }
  return rows.map((r) => companyJob(r, siteUrl)).filter((j): j is DigestJob => j !== null);
}
