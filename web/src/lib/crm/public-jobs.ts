import type { z } from "zod";
import { cleanText, companyJobLocation } from "@/lib/digest/format";
import { jobsDb, type JobsDb } from "@/lib/jobs-db";
import { companyKey } from "@/lib/jobs/clean";
import { type CompanyProfiles, companyProfiles, profileFor } from "@/lib/jobs/companies";
import { jobVia } from "@/lib/jobs/link";
import { crawlPool, parseDbTime, publicSalary, type PoolJob } from "@/lib/jobs/pool";
import { foldText, mentionsCity } from "@/lib/jobs/place";
import { companySiteUrl, isFreshQuote } from "@/lib/jobs/token";
import { isoTime, sqlTime } from "@/lib/time";
import type { ActionContext } from "./context";
import { applyUrlOf, publicJobUrl, rolesOf, workModesOf } from "./jobs";
import { ActionError, type PublicJobList as PublicJobListSchema, type RoleKey } from "./types";

/**
 * Публічне для кандидатів і їхніх агентів: search_jobs (GET /public/jobs, MCP), сторінка
 * /jobs/<id> і перехід "Apply" (/jobs/<id>/apply). Лише вакансії, ніколи люди.
 *
 * search_jobs шукає у двох пулах:
 * - живі вакансії компаній (подання company_jobs_live, 0012): одне читання на пошук,
 *   не більше COMPANY_POOL_CAP рядків (відкритих у компанії щонайбільше 10);
 * - вакансії зі сканування (база вакансій JOBS_DB, лише читання) з тими самими вікном свіжості, тегом web3
 *   і ситами, що в добірці engine (lib/jobs/pool.ts); пул тримається в пам'яті
 *   ізолята POOL_TTL_MS, тож пошук між читаннями базу вакансій не чіпає.
 * База вакансій не відповіла: пошук віддає вакансії компаній (у журнал попередження).
 *
 * Порядок: новіші за датою публікації спершу; без дати в кінці (відсутнє значення не
 * випереджає справжнє), далі за job_id. Курсор = позиція останньої відданої вакансії.
 */

export type PublicJobList = z.infer<typeof PublicJobListSchema>;
type PublicJob = PublicJobList["data"][number];

/** Скільки живих вакансій компаній пошук читає найбільше. */
export const COMPANY_POOL_CAP = 1000;
const DEFAULT_LIMIT = 20;

export interface SearchJobsInput {
  q?: string;
  role?: RoleKey;
  work_mode?: "remote" | "city";
  city?: string;
  salary_min?: number;
  currency?: string;
  cursor?: string;
  limit?: number;
}

type LiveRow = {
  id: string;
  title: string;
  description: string;
  roles: string;
  remote_mode: string;
  city: string | null;
  country: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  salary_period: "year" | "month" | null;
  apply_url: string | null;
  tags: string;
  published_at: string | null;
  expires_at: string | null;
  company_name: string;
  company_domain: string | null;
  company_domain_verified: number;
};

const LIVE_COLUMNS = `id, title, description, roles, remote_mode, city, country, salary_min, salary_max, salary_currency,
  salary_period, apply_url, tags, published_at, expires_at, company_name, company_domain, company_domain_verified`;

function tagsOf(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function companyPoolJob(r: LiveRow, env: { SITE_URL?: string }): PoolJob {
  const workMode = workModesOf(r.remote_mode);
  const city = workMode.includes("city") ? r.city : null;
  const postedMs = parseDbTime(r.published_at);
  return {
    jobId: r.id,
    source: "company",
    title: r.title,
    company: r.company_name,
    companyDomainVerified: r.company_domain_verified === 1,
    workMode,
    city,
    placeText: city,
    // Та сама межа 10k..5M за рік, що при збереженні (lib/crm/jobs.ts) і в добірці.
    salary: publicSalary(r.salary_min, r.salary_max, r.salary_currency, r.salary_period ?? "year"),
    roles: rolesOf(r.roles),
    url: publicJobUrl(env, r.id),
    postedAt: isoTime(r.published_at),
    postedMs,
    haystack: foldText([r.title, r.company_name, ...tagsOf(r.tags)].join(" ")),
    // Як companyJob в engine/src/digest/jobs.ts: ключ компанії з назви, місце «Remote or Lisbon».
    companyKey: companyKey(r.company_name),
    location: companyJobLocation(r.remote_mode, r.city),
    country: r.country,
    seenMs: null,
    firstSeenMs: null,
    dedupeKey: null,
    origin: null,
    salaryEstimate: null,
  };
}

/**
 * Живі вакансії компаній (подання company_jobs_live): одне читання, не більше
 * COMPANY_POOL_CAP рядків. Спільне для search_jobs, «Jobs for you now» на /jobs і головної.
 */
export async function loadCompanyJobs(db: D1Database, env: { SITE_URL?: string }): Promise<PoolJob[]> {
  const { results } = await db
    .prepare(`SELECT ${LIVE_COLUMNS} FROM company_jobs_live ORDER BY published_at DESC, id LIMIT ?`)
    .bind(COMPANY_POOL_CAP)
    .all<LiveRow>();
  return results.map((r) => companyPoolJob(r, env));
}

function companyPool(ctx: ActionContext): Promise<PoolJob[]> {
  return loadCompanyJobs(ctx.db, ctx.env);
}

// ---------------------------------------------------------------------------
// Фільтри й порядок

/** Верх межі зарплати за рік (місячну множимо на 12); null, якщо зарплати немає. */
function annualTop(s: PoolJob["salary"]): number | null {
  if (!s) return null;
  const top = s.max ?? s.min;
  return top === null ? null : top * (s.period === "month" ? 12 : 1);
}

function matches(job: PoolJob, input: SearchJobsInput): boolean {
  if (input.role && !job.roles.includes(input.role)) return false;
  if (input.q) {
    const words = foldText(input.q).split(" ").filter(Boolean);
    if (!words.every((w) => job.haystack.includes(w))) return false;
  }
  const city = input.city?.trim();
  if (input.work_mode === "remote") {
    // Лише віддалені; місто тоді не звужує.
    if (!job.workMode.includes("remote")) return false;
  } else if (city) {
    // Місто словом у локації (як у добірці): «Remote or Lisbon» теж підходить тому, хто шукає Lisbon.
    if (!mentionsCity(job.placeText, city)) return false;
  } else if (input.work_mode === "city" && !job.workMode.includes("city")) {
    return false;
  }
  if (input.salary_min !== undefined) {
    // Лише та сама валюта (USD, якщо не сказано іншої): курсів ми не вгадуємо.
    const currency = input.currency ?? "USD";
    const top = annualTop(job.salary);
    if (top === null || job.salary?.currency !== currency || top < input.salary_min) return false;
  }
  return true;
}

/** Новіші спершу, без дати в кінці, далі компанії перед сканованими і за job_id. */
function compare(a: PoolJob, b: PoolJob): number {
  if (a.postedMs !== b.postedMs) {
    if (a.postedMs === null) return 1;
    if (b.postedMs === null) return -1;
    return b.postedMs - a.postedMs;
  }
  if (a.source !== b.source) return a.source === "company" ? -1 : 1;
  return a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0;
}

type Cursor = { p: number | null; s: PoolJob["source"]; id: string };

const cursorError = () =>
  new ActionError("validation_failed", 422, "Some fields are not valid.", { fields: { cursor: "This cursor is not valid." } });

function encodeCursor(job: PoolJob): string {
  const c = { v: 1, p: job.postedMs, s: job.source, id: job.jobId };
  return btoa(JSON.stringify(c)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function openCursor(cursor: string): Cursor {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw cursorError();
  let v: { v?: unknown; p?: unknown; s?: unknown; id?: unknown } | null;
  try {
    v = JSON.parse(atob(cursor.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    throw cursorError();
  }
  if (!v || v.v !== 1 || (v.p !== null && !Number.isSafeInteger(v.p)) || (v.s !== "company" && v.s !== "crawl") || typeof v.id !== "string") {
    throw cursorError();
  }
  return { p: v.p as number | null, s: v.s, id: v.id };
}

/**
 * Вакансія для search_jobs (REST і MCP). `url` рівно та адреса, що в базі: для web3.career це їхній
 * apply_url, який не можна міняти (lib/jobs/link.ts); `via` каже, кого назвати джерелом.
 *
 * `company_url` і `company_token` лише для вакансій зі сканування (job.source === "crawl"): у вакансії
 * компанії є своя сторінка на сайті, а токен реєстру (JOBS_DB companies, db/jobs 0004) зіставлений з
 * доменом сканованих компаній, а не з нашими власними (той самий порядок, що в digest/schedule.ts engine).
 */
function toPublic(job: PoolJob, profiles: CompanyProfiles, now: Date): PublicJob {
  const via = job.source === "crawl" ? jobVia(job.url) : null;
  const known = job.source === "crawl" ? profileFor(profiles, job.companyKey, job.company) : null;
  const quote = known?.token ?? null;
  return {
    job_id: job.jobId,
    source: job.source,
    title: job.title,
    company: job.company,
    ...(job.companyDomainVerified !== undefined ? { company_domain_verified: job.companyDomainVerified } : {}),
    work_mode: job.workMode,
    city: job.city,
    salary: job.salary,
    roles: job.roles,
    url: job.url,
    posted_at: job.postedAt,
    ...(via ? { via } : {}),
    // Оцінка дошки окремим полем і лише без зарплати роботодавця; фільтр salary_min (matches) її не бачить.
    ...(job.salaryEstimate && !job.salary
      ? { salary_estimate: { min: job.salaryEstimate.min, max: job.salaryEstimate.max, currency: job.salaryEstimate.currency,
          period: job.salaryEstimate.period, source: job.salaryEstimate.by } }
      : {}),
    company_url: companySiteUrl(known?.domain),
    company_token:
      quote && isFreshQuote(quote, now)
        ? { symbol: quote.symbol, price_usd: quote.priceUsd, mcap_usd: quote.mcapUsd, change_24h: quote.change24h, updated_at: quote.updatedAt }
        : null,
  };
}

/** search_jobs: одна сторінка живих вакансій компаній і зі сканування за фільтрами. */
export async function searchJobs(
  ctx: ActionContext,
  input: SearchJobsInput,
  deps: { jobs?: () => JobsDb } = {},
): Promise<PublicJobList> {
  const after = input.cursor ? openCursor(input.cursor) : null;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const jobsOpen = deps.jobs ?? jobsDb;
  const [company, crawl, profiles] = await Promise.all([companyPool(ctx), crawlPool(jobsOpen, ctx.now), companyProfiles(jobsOpen)]);
  const found = [...company, ...(crawl ?? [])].filter((j) => matches(j, input)).sort(compare);
  let start = 0;
  if (after) {
    const key = { postedMs: after.p, source: after.s, jobId: after.id } as PoolJob;
    start = found.findIndex((j) => compare(j, key) > 0);
    if (start === -1) start = found.length;
  }
  const page = found.slice(start, start + limit);
  const last = page.at(-1);
  return {
    data: page.map((j) => toPublic(j, profiles, ctx.now)),
    next_cursor: start + limit < found.length && last ? encodeCursor(last) : null,
  };
}

// ---------------------------------------------------------------------------
// Публічна сторінка й перехід "Apply"

export interface PublicJobPage {
  id: string;
  title: string;
  description: string;
  roles: RoleKey[];
  workMode: ("remote" | "city")[];
  city: string | null;
  country: string | null;
  salary: PoolJob["salary"];
  tags: string[];
  company: string;
  companyDomain: string | null;
  companyDomainVerified: boolean;
  /** ISO з Z. */
  postedAt: string | null;
  expiresAt: string | null;
}

/** Жива вакансія компанії для /jobs/<id>; null, якщо її немає, вона закрита, прихована чи прострочена. */
export async function loadPublicJob(db: D1Database, id: string): Promise<PublicJobPage | null> {
  const r = await db.prepare(`SELECT ${LIVE_COLUMNS} FROM company_jobs_live WHERE id = ?`).bind(id).first<LiveRow>();
  if (!r) return null;
  const workMode = workModesOf(r.remote_mode);
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    roles: rolesOf(r.roles),
    workMode,
    city: r.city,
    country: r.country,
    salary: publicSalary(r.salary_min, r.salary_max, r.salary_currency, r.salary_period ?? "year"),
    tags: tagsOf(r.tags),
    company: cleanText(r.company_name, 100),
    companyDomain: r.company_domain,
    companyDomainVerified: r.company_domain_verified === 1,
    postedAt: isoTime(r.published_at),
    expiresAt: isoTime(r.expires_at),
  };
}

/** Одна людина (IP) рахується раз на вакансію за стільки хвилин. */
export const APPLY_DEDUPE_MINUTES = 10;
/** Скільки прострочених рядків apply_click_seen прибирає один перехід. */
const APPLY_PURGE_BATCH = 20;

/**
 * Адреса живої вакансії для "Apply"; null, якщо вакансія не жива. Адресу перевірено при
 * збереженні; ще раз (https:// або mailto:), бо рядок міг потрапити в базу повз реєстр.
 */
export async function liveApplyUrl(db: D1Database, id: string): Promise<string | null> {
  const row = await db.prepare("SELECT apply_url FROM company_jobs_live WHERE id = ?").bind(id).first<{ apply_url: string | null }>();
  return row?.apply_url ? applyUrlOf(row.apply_url) : null;
}

/**
 * Перехід "Apply" (специфікація 5.6): +1 до apply_clicks, але не частіше за раз на
 * APPLY_DEDUPE_MINUTES для однієї пари (відвідувач, вакансія). `visitor` = ключ пари
 * (HMAC від IP і id вакансії, IP як є не зберігаємо, 0018); null = не рахувати (бот,
 * передвантаження, забагато запитів з цієї IP).
 *
 * Одним пакетом: прибрати кілька прострочених рядків, поставити або оновити рядок пари
 * (оновлюється лише прострочений), і лише якщо він змінився (changes() = 1), додати перехід
 * живій вакансії. Rate Limiting Workers тут не годиться: його період 10 або 60 с, а треба 10 хв.
 *
 * null, якщо вакансія не жива (лічильник не рухається).
 */
export async function recordApplyClick(
  db: D1Database,
  id: string,
  visitor: string | null,
  now = new Date(),
): Promise<{ url: string; counted: boolean } | null> {
  const url = await liveApplyUrl(db, id);
  if (!url) return null;
  if (!visitor) return { url, counted: false };
  const at = sqlTime(now);
  const stale = sqlTime(new Date(now.getTime() - APPLY_DEDUPE_MINUTES * 60_000));
  const [, , counted] = await db.batch([
    db
      .prepare(
        `DELETE FROM apply_click_seen WHERE key IN (
           SELECT key FROM apply_click_seen WHERE seen_at <= ? ORDER BY seen_at LIMIT ${APPLY_PURGE_BATCH})`,
      )
      .bind(stale),
    db
      .prepare(
        `INSERT INTO apply_click_seen (key, seen_at) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET seen_at = excluded.seen_at WHERE apply_click_seen.seen_at <= ?`,
      )
      .bind(visitor, at, stale),
    // changes() = рядки, змінені попередньою інструкцією пакета: пара нова або її 10 хвилин минули.
    db
      .prepare(
        `UPDATE company_jobs SET apply_clicks = apply_clicks + 1
          WHERE id = ? AND changes() = 1 AND EXISTS (SELECT 1 FROM company_jobs_live l WHERE l.id = ?)`,
      )
      .bind(id, id),
  ]);
  return { url, counted: (counted.meta.changes ?? 0) === 1 };
}
