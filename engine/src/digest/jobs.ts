// Пул вакансій для добірки: база вакансій NextCryptoJob (лише читання; пише її сканер engine,
// src/jobs) і живі вакансії компаній у нашій основній базі. Пул читається один раз на прогін для
// всіх людей, чия година настала, і лише якщо такі є.
//
// Мітки 'nextrole' (DigestJob.source, sent.source) і 'nr:' (sent.job_ref) означають «вакансія
// зі сканування», а не компанії: це збережені значення (CHECK у db/migrations/0006_digest.sql і
// контракт листа), тож лишаються з часів, коли вакансії читались з бази NextRole (до 14.09.2026).
import type { Db } from "../pipeline/db.js";
import { ATS_PROVIDERS } from "../jobs/types.js";
import { companyKey, isNonCryptoCompany } from "./clean.js";
import type { JobsDb } from "./jobs-db.js";
import { annualRange, type DigestJob, formatSalary, isFresh, isRemoteLocation, type JobSalary } from "./match.js";
import { parseRoles, titleRoles } from "./roles.js";

// Правило «жива вакансія» (14.09.2026, однакове для сканера, добірки, сайту й адмінки):
//   1. Вакансія є в ОСТАННЬОМУ вдалому скані свого джерела. Скан пише всім рядкам прогону той самий
//      fetched_at, тож «в останньому скані» = fetched_at дорівнює найсвіжішому fetched_at джерела.
//      Зникла з вдалого скану = не жива одразу. Джерело впало = його fetched_at не рухається, і
//      вакансії лишаються живими, поки останній вдалий скан не старший за LIVE_WINDOW_DAYS.
//   2. Вік від дати публікації (без неї від first_seen_at, коли скан побачив її вперше):
//      власна дошка роботодавця на ATS (Greenhouse, Lever, Ashby…) до ATS_WINDOW_DAYS: поки вакансія
//      є у фіді роботодавця, вона відкрита; дошки й агрегатори (web3.career, JobStash, remote3,
//      speedrun) до POSTED_WINDOW_DAYS: оголошення на дошці може бути застарілим.

/**
 * Запас для джерела, що не прочиталось: скільки днів після його останнього вдалого скану вакансії
 * ще живі. Скан щодня (і у вихідні); три доби = два пропущені скани. Старіше за 30 днів прибирає jobs-prune.
 */
export const LIVE_WINDOW_DAYS = 3;
/** Дошки й агрегатори: опубліковано не давніше (match.ts FRESH_DAYS, та сама межа «свіжої»). */
export const POSTED_WINDOW_DAYS = 30;
/** Власна дошка роботодавця на ATS: відкрита, поки є у фіді, але не давніше за стільки днів. */
export const ATS_WINDOW_DAYS = 90;
const DAY_MS = 86_400_000;

/** Джерело = власний фід роботодавця: `<ats>:<slug>` з відомим провайдером ATS (engine/src/jobs/types.ts). */
export function isEmployerFeed(source: string | null | undefined): boolean {
  const i = (source ?? "").indexOf(":");
  return i > 0 && (ATS_PROVIDERS as readonly string[]).includes(source!.slice(0, i));
}

/** Скільки днів від публікації (чи першої появи) вакансія цього джерела може бути живою. */
export function openWindowDays(source: string | null | undefined): number {
  return isEmployerFeed(source) ? ATS_WINDOW_DAYS : POSTED_WINDOW_DAYS;
}

/** isEmployerFeed мовою SQL: провайдер до першої ':' у списку ATS. Решта (board:, aggregator:, невідоме) = дошка. */
export const EMPLOYER_FEED_SQL = `substr(source, 1, instr(source, ':') - 1) IN (${ATS_PROVIDERS.map((p) => `'${p}'`).join(", ")})`;

/**
 * Один запит на прогін. Індексу на fetched_at у jobs_cache немає навмисно (db/jobs/0001_schema.sql:
 * скан щодня переписує fetched_at у кожного рядка, і індекс з ним подвоював би записи, а записи D1
 * в тисячу разів дорожчі за читання), тож це повний прохід по таблиці: база лише крипто, тисячі
 * рядків, і читається лише в години, коли комусь пора добірка. Найсвіжіший fetched_at джерела
 * рахується вікном (PARTITION BY source) до решти умов: інакше рядок, що випав з вікна віку, лишив би
 * джерело з давнішим «останнім сканом». Тег web3 сканер ставить кожному рядку; умова лишається
 * запобіжником. Час сканер пише як ISO з 'T' і 'Z', тому межі теж ISO. Параметри: poolParams.
 */
export const POOL_SQL = `SELECT id, url, company, company_key, title, location, remote, salary_min, salary_max,
       salary_currency, tags, posted_at, fetched_at, first_seen_at, country, dedupe_key, salary_est_min, salary_est_max,
       salary_est_currency, source
  FROM (SELECT *, MAX(fetched_at) OVER (PARTITION BY source) AS source_seen_at FROM jobs_cache WHERE fetched_at >= ?)
 WHERE fetched_at = source_seen_at AND tags LIKE '%"web3"%'
   AND COALESCE(posted_at, first_seen_at) >= CASE WHEN ${EMPLOYER_FEED_SQL} THEN ? ELSE ? END`;

/** Параметри POOL_SQL: [запас для джерела, що не прочиталось; межа віку ATS; межа віку дошки]. */
export function poolParams(now: Date): [string, string, string] {
  const ago = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();
  return [ago(LIVE_WINDOW_DAYS), ago(ATS_WINDOW_DAYS), ago(POSTED_WINDOW_DAYS)];
}

/** Рядок POOL_SQL. */
export type PoolRow = {
  id: string; url: string; company: string; company_key: string; title: string; location: string | null;
  remote: number; salary_min: number | null; salary_max: number | null; salary_currency: string | null;
  tags: string; posted_at: string | null; fetched_at: string; country: string | null; dedupe_key: string | null;
  /** Коли скан побачив вакансію вперше: вік вакансії без дати публікації. */
  first_seen_at?: string | null;
  /** Оцінка дошки (db/jobs/0002), не вилка: у DigestJob не йде, лише в текст добірки (salaryEstimateOf). */
  salary_est_min?: number | null; salary_est_max?: number | null; salary_est_currency?: string | null;
  /** jobs_cache.source: чия оцінка (підпис «web3.career estimate») і рядок джерел на головній сайту. */
  source?: string | null;
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
  /** З них ще відкриті, але опубліковані давніше за FRESH_DAYS (добірка бере їх лише добрати до п'яти). */
  older: number;
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
      postedAt: parseDbTime(r.posted_at), firstSeenAt: parseDbTime(r.first_seen_at), seenAt: parseDbTime(r.fetched_at),
      dedupeKey: r.dedupe_key, roles,
    },
  };
}

/**
 * Оцінка зарплати від дошки (web3.career), річна. Навмисно поза DigestJob: підбір, лічильники й
 * «Salary listed» у поясненні її не бачать. Лише для вакансії без вилки роботодавця.
 */
export function salaryEstimateOf(r: PoolRow): JobSalary | null {
  if (r.salary_min !== null || r.salary_max !== null) return null;
  const s = salaryOf(r.salary_est_min ?? null, r.salary_est_max ?? null, r.salary_est_currency ?? null, null);
  return s && annualRange(s) ? s : null;
}

/** Хто оцінив: назва дошки для підпису «(web3.career estimate)». */
export function estimateSourceOf(source: string | null | undefined): string {
  return source === "board:web3career" ? "web3.career" : (source ?? "board").replace(/^(board|aggregator):/, "");
}

/** Оцінка дошки для вакансії пулу: суми й хто оцінив. */
export type SalaryEstimate = { salary: JobSalary; by: string };

/** «est. $180k to $225k (web3.career estimate)»; null, якщо показати нічого. */
export function estimateText(e: SalaryEstimate | null | undefined): string | null {
  const money = e ? formatSalary(e.salary) : null;
  return e && money ? `est. ${money} (${e.by} estimate)` : null;
}

export async function loadCrawlPool(jobs: JobsDb, now: Date): Promise<{ jobs: DigestJob[]; stats: PoolStats; estimates: Map<string, SalaryEstimate> }> {
  const res = await jobs.select<PoolRow>(POOL_SQL, poolParams(now));
  const out: DigestJob[] = [];
  const estimates = new Map<string, SalaryEstimate>();
  const dropped = { tag: 0, company: 0, title: 0 };
  for (const r of res.rows) {
    const x = crawlJob(r);
    if (!("job" in x)) { dropped[x.drop]++; continue; }
    out.push(x.job);
    const est = salaryEstimateOf(r);
    if (est) estimates.set(x.job.ref, { salary: est, by: estimateSourceOf(r.source) });
  }
  return {
    jobs: out, estimates,
    stats: { fetched: res.rows.length, kept: out.length, older: out.filter((j) => !isFresh(j, now)).length, dropped, rowsRead: res.meta.rowsRead, d1Ms: res.meta.durationMs, wallMs: res.wallMs },
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
    postedAt: parseDbTime(r.published_at), firstSeenAt: null, seenAt: null, dedupeKey: null, roles,
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
