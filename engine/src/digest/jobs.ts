// Пул вакансій для добірки: база вакансій NextCryptoJob (лише читання; пише її сканер engine,
// src/jobs) і живі вакансії компаній у нашій основній базі. Пул читається один раз на прогін для
// всіх людей, чия година настала, і лише якщо такі є.
//
// Мітки 'nextrole' (DigestJob.source, sent.source) і 'nr:' (sent.job_ref) означають «вакансія
// зі сканування», а не компанії: це збережені значення (CHECK у db/migrations/0006_digest.sql і
// контракт листа), тож лишаються з часів, коли вакансії читались з бази NextRole (до 14.09.2026).
import type { Db } from "../pipeline/db.js";
import { companyKey, isNonCryptoCompany } from "./clean.js";
import type { JobsDb } from "./jobs-db.js";
import { type DigestJob, isRemoteLocation, type JobSalary } from "./match.js";
import { parseRoles, titleRoles } from "./roles.js";

/**
 * Скільки днів тому скан мав бачити вакансію на дошці. Скан щодня (і у вихідні) оновлює
 * fetched_at у кожної побаченої; хто випав з вікна, той знятий з дошки. Три доби: запас на
 * два пропущені скани. Старіше за 30 днів прибирає jobs-prune.
 */
export const LIVE_WINDOW_DAYS = 3;
/** Свіжість за датою публікації (match.ts FRESH_DAYS); тут лише щоб не тягнути старе з бази. */
export const POSTED_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * Один запит на прогін. Індексу на fetched_at у jobs_cache немає навмисно (db/jobs/0001_schema.sql:
 * скан щодня переписує fetched_at у кожного рядка, і індекс з ним подвоював би записи, а записи D1
 * в тисячу разів дорожчі за читання), тож це повний прохід по таблиці: база лише крипто, тисячі
 * рядків, і читається лише в години, коли комусь пора добірка. Тег web3 сканер ставить кожному
 * рядку; умова лишається запобіжником. Час сканер пише як ISO з 'T' і 'Z', тому межі теж ISO.
 */
export const POOL_SQL = `SELECT id, url, company, company_key, title, location, remote, salary_min, salary_max,
       salary_currency, tags, posted_at, fetched_at, country, dedupe_key
  FROM jobs_cache
 WHERE fetched_at >= ? AND tags LIKE '%"web3"%' AND (posted_at IS NULL OR posted_at >= ?)`;

/** Рядок POOL_SQL. */
export type PoolRow = {
  id: string; url: string; company: string; company_key: string; title: string; location: string | null;
  remote: number; salary_min: number | null; salary_max: number | null; salary_currency: string | null;
  tags: string; posted_at: string | null; fetched_at: string; country: string | null; dedupe_key: string | null;
};

type CompanyRow = {
  id: string; company_id: string; company_name: string; title: string; roles: string; remote_mode: string; apply_url: string | null;
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

/** Рядок бази вакансій → вакансія пулу; drop, якщо це не крипто або не наша роль. */
export function crawlJob(r: PoolRow): { job: DigestJob } | { drop: "tag" | "company" | "title" } {
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

export async function loadCrawlPool(jobs: JobsDb, now: Date): Promise<{ jobs: DigestJob[]; stats: PoolStats }> {
  const live = new Date(now.getTime() - LIVE_WINDOW_DAYS * DAY_MS).toISOString();
  const posted = new Date(now.getTime() - POSTED_WINDOW_DAYS * DAY_MS).toISOString();
  const res = await jobs.select<PoolRow>(POOL_SQL, [live, posted]);
  const out: DigestJob[] = [];
  const dropped = { tag: 0, company: 0, title: 0 };
  for (const r of res.rows) {
    const x = crawlJob(r);
    if ("job" in x) out.push(x.job); else dropped[x.drop]++;
  }
  return {
    jobs: out,
    stats: { fetched: res.rows.length, kept: out.length, dropped, rowsRead: res.meta.rowsRead, d1Ms: res.meta.durationMs, wallMs: res.wallMs },
  };
}

/**
 * Посилання на вакансію компанії: публічна сторінка на сайті (специфікація CRM 5.6).
 * Звідти "Apply" веде на apply_url компанії й рахує переходи (company_jobs.apply_clicks).
 */
export function companyJobUrl(siteUrl: string, id: string): string {
  return `${siteUrl.replace(/\/+$/, "")}/jobs/${encodeURIComponent(id)}`;
}

export function companyJob(r: CompanyRow, siteUrl: string): DigestJob | null {
  const roles = parseRoles(r.roles);
  // Відкрита вакансія без apply_url неможлива (CHECK у 0003); без адреси сторінці нема куди вести людину.
  if (roles.length === 0 || !r.apply_url) return null;
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

/**
 * Живі вакансії компаній (company_jobs_live, 0004/0012), з посиланням на /jobs/<id> сайту.
 * Без подання (база без 0003/0004) → порожньо.
 */
export async function loadCompanyPool(db: Db, log: (l: string) => void, siteUrl: string): Promise<DigestJob[]> {
  let rows: CompanyRow[];
  try {
    rows = await db.query<CompanyRow>(
      `SELECT id, company_id, company_name, title, roles, remote_mode, apply_url, city, country, salary_min, salary_max,
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
