import type { RoleKey } from "@/lib/card/roles";
import { cleanText, plausibleSalary, safeUrl } from "@/lib/digest/format";
import type { JobsDb } from "@/lib/jobs-db";
import { companyKey, isNonCryptoCompany } from "./clean";
import { foldText, isRemoteLocation } from "./place";
import { titleRoles } from "./roles";

/**
 * Вакансії зі сканування (база вакансій NextCryptoJob, binding JOBS_DB; пише її сканер engine,
 * engine/src/jobs) для публічного search_jobs (lib/crm/public-jobs.ts): той самий пул, що бере
 * добірка engine (engine/src/digest/jobs.ts): ті самі вікна свіжості, той самий SQL з тегом web3,
 * ті самі сита компанії й назви. Тест parity.test.ts звіряє константи й SQL з engine.
 *
 * Межа читань. Індексу на fetched_at у jobs_cache немає навмисно (db/jobs/0001_schema.sql: записи
 * D1 у тисячу разів дорожчі за читання, а скан щодня переписує fetched_at), тож кожен запит пулу
 * це прохід по таблиці. Тому пул не читається на кожен пошук: готовий пул живе в пам'яті
 * ізолята POOL_TTL_MS, і рядків не більше POOL_ROW_CAP (найсвіжіше бачені). Пошуки між
 * читаннями фільтрують пул у пам'яті й базу не чіпають.
 *
 * Незавершений запит між запитами не ділиться: у Workers проміс, створений під час одного
 * запиту, не можна чекати з іншого (I/O належить запиту, що його почав). Тож при промаху
 * кожен запит читає сам; готовий результат уже спільний.
 * База не відповіла: FAILURE_BACKOFF_MS її не питаємо, а віддаємо попередній пул, навіть
 * застарілий (краще вчорашні вакансії, ніж жодної); якщо його немає, лише вакансії компаній.
 */

export const LIVE_WINDOW_DAYS = 3;
export const POSTED_WINDOW_DAYS = 30;
export const POOL_SQL = `SELECT id, url, company, company_key, title, location, remote, salary_min, salary_max,
       salary_currency, tags, posted_at, fetched_at, country, dedupe_key
  FROM jobs_cache
 WHERE fetched_at >= ? AND tags LIKE '%"web3"%' AND (posted_at IS NULL OR posted_at >= ?)`;

/**
 * Запит пулу на сайті: той самий, що в engine (POOL_SQL, тест звіряє), плюс
 * стовпець source для рядка «N live crypto jobs from M sources» на головній. Умова WHERE
 * та сама, тож і рядки ті самі.
 */
export const POOL_READ_SQL = POOL_SQL.replace("country, dedupe_key\n", "country, dedupe_key, source\n");

/** Скільки рядків пул бере найбільше (скан насухо 14.09: ~1 600 живих крипто-вакансій). */
export const POOL_ROW_CAP = 10_000;
/** Як довго ізолят тримає пул у пам'яті. Скан оновлює базу раз на добу. */
export const POOL_TTL_MS = 10 * 60_000;
/** Після невдалого читання базу вакансій не питаємо стільки часу. */
export const FAILURE_BACKOFF_MS = 60_000;
const DAY_MS = 86_400_000;

export interface PublicSalary {
  min: number | null;
  max: number | null;
  currency: string | null;
  period: "year" | "month";
}

/** Вакансія в пулі пошуку, з будь-якого джерела. */
export interface PoolJob {
  /** job_… для вакансій компаній, nr_<id> для вакансій зі сканування (префікс лишився з часів NextRole). */
  jobId: string;
  source: "company" | "crawl";
  title: string;
  company: string;
  companyDomainVerified?: boolean;
  workMode: ("remote" | "city")[];
  city: string | null;
  /** Текст, у якому шукати місто (локація зі сканування або місто вакансії компанії). */
  placeText: string | null;
  salary: PublicSalary | null;
  roles: RoleKey[];
  url: string;
  /** ISO з Z або null, якщо джерело дати не дало. */
  postedAt: string | null;
  postedMs: number | null;
  /** foldText назви, компанії й тегів: по ньому шукає `q`. */
  haystack: string;
  /** Ключ компанії для правила добірки «одна вакансія на компанію» (як companyKey в engine). */
  companyKey: string;
  /** Місце, як його показати людині: «Remote», «Lisbon», «Remote or Lisbon». */
  location: string | null;
  /** Країна національної дошки; такі вакансії добірка не бере у «віддалено». Крипто-джерела лишають null. */
  country: string | null;
  /** Коли скан бачив вакансію востаннє (мс); запасна дата свіжості в добірці. */
  seenMs: number | null;
  /** Ключ змісту: та сама вакансія під новою адресою. */
  dedupeKey: string | null;
  /** jobs_cache.source (дошка, з якої скан узяв вакансію); null для вакансій компаній. */
  origin: string | null;
}

type PoolRow = {
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
  /** Є в POOL_READ_SQL; у запиті engine його немає. */
  source?: string | null;
};

/** Дата з бази: ISO ('…T…Z') або SQLite ('YYYY-MM-DD HH:MM:SS', UTC), як parseDbTime в engine. */
export function parseDbTime(v: string | null | undefined): number | null {
  if (!v) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(v) ? `${v.replace(" ", "T")}Z` : v;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

// Дослівно як tagsOf в engine/src/digest/jobs.ts (тест parity.test.ts звіряє).
function tagsOf(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch { return []; }
}

/** Сума, якою можна вірити: 1 000 у вилці це заглушка, а не зарплата (як formatSalary). */
function plausible(v: number | null, period: "year" | "month"): number | null {
  return v !== null && plausibleSalary(v, period) ? v : null;
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

/**
 * Сито рядка: ті самі перевірки й у тому самому порядку, що в crawlJob engine до побудови
 * вакансії. Тіло до останнього return дослівно як в engine (тест звіряє текст): нове правило
 * там без переносу сюди валить тест.
 */
export function crawlSieve(r: PoolRow): { tags: string[]; roles: RoleKey[] } | { drop: "tag" | "company" | "title" } {
  const tags = tagsOf(r.tags);
  // Тег web3 перевіряє вже SQL (LIKE); тут ще раз точно, бо LIKE бачить і підрядок.
  if (!tags.includes("web3")) return { drop: "tag" };
  if (isNonCryptoCompany(r.company_key, r.company)) return { drop: "company" };
  const roles = titleRoles(r.title, tags);
  if (roles.length === 0) return { drop: "title" };
  return { tags, roles };
}

/** Рядок бази вакансій → вакансія пошуку; null, якщо сито відкинуло рядок або адреса крива. */
export function crawlJob(r: PoolRow): PoolJob | null {
  const sieved = crawlSieve(r);
  if ("drop" in sieved) return null;
  const { tags, roles } = sieved;
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
    companyKey: r.company_key || companyKey(r.company),
    location: location ?? (remote ? "Remote" : null),
    country: r.country,
    seenMs: parseDbTime(r.fetched_at),
    dedupeKey: r.dedupe_key,
    origin: r.source ?? null,
  };
}

let cached: { at: number; jobs: PoolJob[] } | null = null;
let failedAt: number | null = null;

/** Для тестів: наступний пошук читає пул знову. */
export function resetCrawlPool(): void {
  cached = null;
  failedAt = null;
}

async function loadPool(jobs: JobsDb, now: Date, cap: number): Promise<PoolJob[] | null> {
  const live = new Date(now.getTime() - LIVE_WINDOW_DAYS * DAY_MS).toISOString();
  const posted = new Date(now.getTime() - POSTED_WINDOW_DAYS * DAY_MS).toISOString();
  const started = Date.now();
  let rows: PoolRow[];
  try {
    // Найсвіжіше бачені першими: якщо межа спрацює, відріжуться ті, кого скан бачив давніше.
    rows = await jobs.all<PoolRow>(`${POOL_READ_SQL}\n ORDER BY fetched_at DESC\n LIMIT ?`, live, posted, cap);
  } catch (e) {
    console.warn(`search_jobs: JOBS_DB read failed (${e instanceof Error ? e.name : "unknown"})`);
    return null;
  }
  if (rows.length >= cap) {
    console.warn(`search_jobs: job pool hit the ${cap}-row cap; older jobs are left out`);
  }
  const out: PoolJob[] = [];
  for (const r of rows) {
    const job = crawlJob(r);
    if (job) out.push(job);
  }
  console.log(`search_jobs: job pool ${out.length} of ${rows.length} rows in ${Date.now() - started} ms`);
  return out;
}

/**
 * Пул вакансій зі сканування: з пам'яті ізолята, якщо він свіжіший за POOL_TTL_MS; інакше читання цим
 * запитом. Після невдачі FAILURE_BACKOFF_MS без читань, і весь цей час (та й одразу після
 * невдачі) віддається попередній пул, якщо він є. null, якщо пулу немає зовсім.
 */
export async function crawlPool(open: () => JobsDb, now: Date, cap = POOL_ROW_CAP): Promise<PoolJob[] | null> {
  const t = Date.now();
  if (cached && t - cached.at < POOL_TTL_MS) return cached.jobs;
  if (failedAt !== null && t - failedAt < FAILURE_BACKOFF_MS) return cached?.jobs ?? null;
  let pool: PoolJob[] | null;
  try {
    pool = await loadPool(open(), now, cap);
  } catch (e) {
    console.warn(`search_jobs: JOBS_DB is not bound (${e instanceof Error ? e.name : "unknown"})`);
    pool = null;
  }
  if (!pool) {
    failedAt = Date.now();
    if (cached) console.warn("search_jobs: serving the previous job pool while the jobs database does not answer");
    return cached?.jobs ?? null;
  }
  failedAt = null;
  cached = { at: Date.now(), jobs: pool };
  return pool;
}
