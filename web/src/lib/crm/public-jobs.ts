import type { z } from "zod";
import { cleanText } from "@/lib/digest/format";
import { jobsDb, type JobsDb } from "@/lib/jobs-db";
import { nextrolePool, parseDbTime, type PoolJob } from "@/lib/jobs/nextrole-pool";
import { foldText, mentionsCity } from "@/lib/jobs/nextrole-place";
import { isoTime } from "@/lib/time";
import type { ActionContext } from "./context";
import { publicJobUrl, rolesOf, workModesOf } from "./jobs";
import { ActionError, type PublicJobList as PublicJobListSchema, type RoleKey } from "./types";

/**
 * Публічне для кандидатів і їхніх агентів: search_jobs (GET /public/jobs, MCP), сторінка
 * /jobs/<id> і перехід "Apply" (/jobs/<id>/apply). Лише вакансії, ніколи люди.
 *
 * search_jobs шукає у двох пулах:
 * - живі вакансії компаній (подання company_jobs_live, 0012): одне читання на пошук,
 *   не більше COMPANY_POOL_CAP рядків (відкритих у компанії щонайбільше 10);
 * - вакансії NextRole (JOBS_DB, лише читання) з тими самими вікном свіжості, тегом web3
 *   і ситами, що в добірці engine (lib/jobs/nextrole-pool.ts); пул тримається в пам'яті
 *   ізолята POOL_TTL_MS, тож пошук між читаннями базу NextRole не чіпає.
 * База NextRole не відповіла: пошук віддає вакансії компаній (у журнал попередження).
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
    // Зарплату компанії показуємо як задано (перевірено при збереженні, lib/crm/jobs.ts).
    salary:
      r.salary_currency && (r.salary_min !== null || r.salary_max !== null)
        ? { min: r.salary_min, max: r.salary_max, currency: r.salary_currency, period: r.salary_period ?? "year" }
        : null,
    roles: rolesOf(r.roles),
    url: publicJobUrl(env, r.id),
    postedAt: isoTime(r.published_at),
    postedMs,
    haystack: foldText([r.title, r.company_name, ...tagsOf(r.tags)].join(" ")),
  };
}

async function companyPool(ctx: ActionContext): Promise<PoolJob[]> {
  const { results } = await ctx.db
    .prepare(`SELECT ${LIVE_COLUMNS} FROM company_jobs_live ORDER BY published_at DESC, id LIMIT ?`)
    .bind(COMPANY_POOL_CAP)
    .all<LiveRow>();
  return results.map((r) => companyPoolJob(r, ctx.env));
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

/** Новіші спершу, без дати в кінці, далі компанії перед NextRole і за job_id. */
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

function toPublic(job: PoolJob): PublicJob {
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
  };
}

/** search_jobs: одна сторінка живих вакансій компаній і NextRole за фільтрами. */
export async function searchJobs(
  ctx: ActionContext,
  input: SearchJobsInput,
  deps: { jobs?: () => JobsDb } = {},
): Promise<PublicJobList> {
  const after = input.cursor ? openCursor(input.cursor) : null;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const [company, crawl] = await Promise.all([companyPool(ctx), nextrolePool(deps.jobs ?? jobsDb, ctx.now)]);
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
    data: page.map(toPublic),
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
    salary:
      r.salary_currency && (r.salary_min !== null || r.salary_max !== null)
        ? { min: r.salary_min, max: r.salary_max, currency: r.salary_currency, period: r.salary_period ?? "year" }
        : null,
    tags: tagsOf(r.tags),
    company: cleanText(r.company_name, 100),
    companyDomain: r.company_domain,
    companyDomainVerified: r.company_domain_verified === 1,
    postedAt: isoTime(r.published_at),
    expiresAt: isoTime(r.expires_at),
  };
}

/**
 * Перехід "Apply": +1 до apply_clicks і адреса компанії, одним запитом і лише для
 * живої вакансії. null, якщо вакансія не жива (тоді лічильник не рухається).
 */
export async function recordApplyClick(db: D1Database, id: string): Promise<string | null> {
  const row = await db
    .prepare(
      `UPDATE company_jobs SET apply_clicks = apply_clicks + 1
        WHERE id = ? AND EXISTS (SELECT 1 FROM company_jobs_live l WHERE l.id = ?)
        RETURNING apply_url`,
    )
    .bind(id, id)
    .first<{ apply_url: string | null }>();
  return row?.apply_url ?? null;
}

/** Адреса живої вакансії без лічильника (запит-передвантаження браузера, HEAD). */
export async function liveApplyUrl(db: D1Database, id: string): Promise<string | null> {
  const row = await db.prepare("SELECT apply_url FROM company_jobs_live WHERE id = ?").bind(id).first<{ apply_url: string | null }>();
  return row?.apply_url ?? null;
}
