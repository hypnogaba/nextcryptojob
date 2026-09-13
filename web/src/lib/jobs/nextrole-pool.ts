import type { RoleKey } from "@/lib/card/roles";
import { cleanText, plausibleAnnual, safeUrl } from "@/lib/digest/format";
import type { JobsDb } from "@/lib/jobs-db";
import { isNonCryptoCompany } from "./nextrole-clean";
import { foldText, isRemoteLocation } from "./nextrole-place";
import { titleRoles } from "./nextrole-roles";

/**
 * Вакансії NextRole для публічного search_jobs (lib/crm/public-jobs.ts): той самий пул,
 * що бере добірка engine (engine/src/digest/jobs.ts): ті самі вікна свіжості, той самий
 * SQL з тегом web3, ті самі сита компанії й назви. Тест nextrole-parity.test.ts звіряє
 * константи й SQL з engine.
 *
 * Межа читань. Індексу на fetched_at у jobs_cache немає навмисно (записи D1 у тисячу
 * разів дорожчі за читання, reference у engine/src/digest/jobs.ts), тож кожен запит пулу
 * це прохід по таблиці. Тому пул не читається на кожен пошук: один запит на ізолят
 * Worker раз на POOL_TTL_MS (паралельні пошуки чекають той самий запит), і рядків не
 * більше POOL_ROW_CAP. Пошуки між читаннями фільтрують пул у пам'яті й базу не чіпають.
 */

export const LIVE_WINDOW_DAYS = 3;
export const POSTED_WINDOW_DAYS = 30;
export const NEXTROLE_POOL_SQL = `SELECT id, url, company, company_key, title, location, remote, salary_min, salary_max,
       salary_currency, tags, posted_at, fetched_at, country, dedupe_key
  FROM jobs_cache
 WHERE fetched_at >= ? AND tags LIKE '%"web3"%' AND (posted_at IS NULL OR posted_at >= ?)`;

/** Скільки рядків пул бере найбільше (живий кеш 12.09: ~3 100 свіжих з тегом web3). */
export const POOL_ROW_CAP = 10_000;
/** Як довго ізолят тримає пул у пам'яті. Скан NextRole оновлює кеш раз на добу. */
export const POOL_TTL_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

export interface PublicSalary {
  min: number | null;
  max: number | null;
  currency: string | null;
  period: "year" | "month";
}

/** Вакансія в пулі пошуку, з будь-якого джерела. */
export interface PoolJob {
  /** job_… для вакансій компаній, nr_<id> для вакансій NextRole. */
  jobId: string;
  source: "company" | "crawl";
  title: string;
  company: string;
  companyDomainVerified?: boolean;
  workMode: ("remote" | "city")[];
  city: string | null;
  /** Текст, у якому шукати місто (локація NextRole або місто вакансії компанії). */
  placeText: string | null;
  salary: PublicSalary | null;
  roles: RoleKey[];
  url: string;
  /** ISO з Z або null, якщо джерело дати не дало. */
  postedAt: string | null;
  postedMs: number | null;
  /** foldText назви, компанії й тегів: по ньому шукає `q`. */
  haystack: string;
}

type NrRow = {
  id: string;
  url: string;
  company: string;
  company_key: string;
  title: string;
  location: string | null;
  remote: number;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  tags: string;
  posted_at: string | null;
  fetched_at: string;
  country: string | null;
  dedupe_key: string | null;
};

/** Дата з бази: ISO ('…T…Z') або SQLite ('YYYY-MM-DD HH:MM:SS', UTC), як parseDbTime в engine. */
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
  } catch {
    return [];
  }
}

/** Сума, якою можна вірити: 1 000 у кеші NextRole це заглушка, а не зарплата (як formatSalary). */
function plausible(v: number | null, period: "year" | "month"): number | null {
  return v !== null && plausibleAnnual(v * (period === "month" ? 12 : 1)) ? v : null;
}

export function publicSalary(
  min: number | null,
  max: number | null,
  currency: string | null,
  period: "year" | "month",
): PublicSalary | null {
  const lo = plausible(min, period);
  const hi = plausible(max, period);
  if (lo === null && hi === null) return null;
  return { min: lo, max: hi, currency: currency ? currency.toUpperCase() : null, period };
}

/** Рядок кешу NextRole → вакансія пошуку; null, якщо це не крипто, не наша роль або адреса крива. */
export function nextroleJob(r: NrRow): PoolJob | null {
  const tags = tagsOf(r.tags);
  // Тег web3 перевіряє вже SQL (LIKE); тут ще раз точно, бо LIKE бачить і підрядок (як engine).
  if (!tags.includes("web3")) return null;
  if (isNonCryptoCompany(r.company_key, r.company)) return null;
  const roles = titleRoles(r.title, tags);
  if (roles.length === 0) return null;
  const url = safeUrl(r.url);
  if (!url) return null;
  const location = r.location?.trim() ? cleanText(r.location, 100) : null;
  const remote = isRemoteLocation(r.remote === 1, r.location);
  const title = cleanText(r.title, 200);
  const company = cleanText(r.company, 100);
  const postedMs = parseDbTime(r.posted_at);
  return {
    jobId: `nr_${r.id}`,
    source: "crawl",
    title,
    company,
    workMode: remote ? ["remote"] : location ? ["city"] : [],
    city: remote ? null : location,
    placeText: r.location,
    salary: publicSalary(r.salary_min, r.salary_max, r.salary_currency, "year"),
    roles,
    url,
    postedAt: postedMs === null ? null : new Date(postedMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
    postedMs,
    haystack: foldText([title, company, ...tags].join(" ")),
  };
}

let cached: { at: number; jobs: PoolJob[] } | null = null;
let loading: Promise<PoolJob[] | null> | null = null;

/** Для тестів: наступний пошук читає пул знову. */
export function resetNextrolePool(): void {
  cached = null;
  loading = null;
}

async function loadPool(jobs: JobsDb, now: Date): Promise<PoolJob[] | null> {
  const live = new Date(now.getTime() - LIVE_WINDOW_DAYS * DAY_MS).toISOString();
  const posted = new Date(now.getTime() - POSTED_WINDOW_DAYS * DAY_MS).toISOString();
  const started = Date.now();
  let rows: NrRow[];
  try {
    rows = await jobs.all<NrRow>(`${NEXTROLE_POOL_SQL}\n LIMIT ?`, live, posted, POOL_ROW_CAP);
  } catch (e) {
    // База NextRole чужа й буває зайнята (429): пошук віддає вакансії компаній без неї.
    console.warn(`search_jobs: JOBS_DB read failed (${e instanceof Error ? e.name : "unknown"})`);
    return null;
  }
  const out: PoolJob[] = [];
  for (const r of rows) {
    const job = nextroleJob(r);
    if (job) out.push(job);
  }
  console.log(`search_jobs: NextRole pool ${out.length} of ${rows.length} rows in ${Date.now() - started} ms`);
  return out;
}

/**
 * Пул NextRole: з пам'яті ізолята, якщо він свіжіший за POOL_TTL_MS, інакше одне читання
 * (паралельні виклики чекають його). null, якщо базу зараз не прочитали (не кешується).
 */
export async function nextrolePool(open: () => JobsDb, now: Date): Promise<PoolJob[] | null> {
  if (cached && Date.now() - cached.at < POOL_TTL_MS) return cached.jobs;
  if (!loading) {
    let jobs: JobsDb;
    try {
      jobs = open();
    } catch (e) {
      console.warn(`search_jobs: JOBS_DB is not bound (${e instanceof Error ? e.name : "unknown"})`);
      return null;
    }
    loading = loadPool(jobs, now)
      .then((pool) => {
        if (pool) cached = { at: Date.now(), jobs: pool };
        return pool;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}
