import type { RoleKey } from "@/lib/card/roles";
import { loadCompanyJobs } from "@/lib/crm/public-jobs";
import type { JobsDb } from "@/lib/jobs-db";
import {
  type DigestJob,
  type DigestPick,
  type DigestProfile,
  formatSalary,
  isFresh,
  placeMatch,
  selectJobs,
  workModes,
} from "./nextrole-match";
import { FAILURE_BACKOFF_MS, nextrolePool, POOL_TTL_MS, type PoolJob } from "./nextrole-pool";
import { parseRoles, ROLE_NAMES } from "./nextrole-roles";

/**
 * Вакансії «зараз», тими самими правилами, що й щоденна добірка engine:
 * - «Jobs for you now» на /jobs: вибір для людини з сесії одразу після анкети;
 * - «Today's jobs» на головній: приклад добірки для вигаданої анкети й рядок про кількість.
 *
 * Правила не свої: selectJobs і решта з nextrole-match.ts (дослівна копія engine/src/digest/match.ts),
 * пул той самий, що в search_jobs (nextrole-pool.ts, пам'ять ізолята POOL_TTL_MS) плюс живі
 * вакансії компаній (company_jobs_live, одне читання, не більше COMPANY_POOL_CAP рядків).
 * Сторінка нічого не пише: вибір «зараз» не займає місця в добірці й не рахується як надісланий.
 */

/** Вакансія, як її показати людині (сторінка /jobs і головна). */
export type ShownJob = {
  /** 'nr:<id>' або 'co:<id>', як sent.job_ref. */
  ref: string;
  title: string;
  company: string;
  location: string | null;
  salary: string | null;
  why: string;
  /** Вакансія компанії: її сторінка на сайті /jobs/<id>; NextRole: http(s) чи mailto; null, якщо адреса крива. */
  url: string | null;
  /** «Posted by {Company} on NextCryptoJob» для вакансій компаній. */
  postedBy: string | null;
};

/** Колонки users, з яких складається анкета добірки. */
export type BriefRow = {
  roles: string;
  remote_mode: string | null;
  city: string | null;
  salary_min: number | null;
  salary_currency: string | null;
};

/** Анкета для підбору, як profileOf у engine/src/digest/schedule.ts (тест звіряє). */
export function profileOf(u: BriefRow): DigestProfile {
  return {
    roles: parseRoles(u.roles), remoteMode: u.remote_mode, city: u.city?.trim() || null,
    salaryMin: u.salary_min, salaryCurrency: u.salary_currency,
  };
}

/** Вакансія пулу сайту → вакансія добірки (як nextroleJob і companyJob в engine/src/digest/jobs.ts). */
export function digestJobOf(job: PoolJob): DigestJob {
  const company = job.source === "company";
  const id = company ? job.jobId : job.jobId.replace(/^nr_/, "");
  return {
    ref: company ? `co:${id}` : `nr:${id}`,
    source: company ? "company" : "nextrole",
    id,
    title: job.title,
    company: job.company,
    companyKey: job.companyKey,
    url: company ? `/jobs/${encodeURIComponent(id)}` : job.url,
    location: job.location,
    placeText: job.placeText,
    remote: job.workMode.includes("remote"),
    country: job.country,
    salary: job.salary,
    postedAt: job.postedMs,
    seenAt: job.seenMs,
    dedupeKey: job.dedupeKey,
    roles: job.roles,
  };
}

function shown(pick: DigestPick): ShownJob {
  const j = pick.job;
  const company = j.source === "company";
  return {
    ref: j.ref,
    title: j.title,
    company: j.company,
    location: j.location,
    salary: formatSalary(j.salary),
    why: pick.why,
    url: j.url,
    postedBy: company ? j.company : null,
  };
}

type Pool = { nextrole: DigestJob[]; company: DigestJob[] };

// ---------------------------------------------------------------------------
// «Jobs for you now»

/** Чому нічого не підійшло: так, щоб людина знала, що змінити в анкеті. */
export type NoMatchReason =
  | { kind: "no_roles" }
  /** Жодної живої вакансії для ролей людини, де б вона не була. */
  | { kind: "no_role_jobs"; roles: RoleKey[] }
  /** Лише місто, і в ньому нічого; `remote` = скільки таких самих вакансій віддалено. */
  | { kind: "city_only"; city: string; remote: number }
  /** Лише віддалено, і віддалених немає; `inCities` = скільки є в містах. */
  | { kind: "remote_only"; inCities: number }
  /** Усе, що підходить, уже надіслано. */
  | { kind: "all_sent" };

export type InstantMatches =
  | { state: "ok"; jobs: ShownJob[] }
  | { state: "none"; reason: NoMatchReason }
  /** Базу вакансій NextRole зараз не прочитали (і попереднього пулу в ізоляті немає). */
  | { state: "unavailable" };

/** Людська назва кількох ролей: «Engineer», «Engineer or Trader», «Engineer, DevRel or Trader». */
export function roleList(roles: readonly RoleKey[]): string {
  const names = roles.map((r) => ROLE_NAMES[r]);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

/** Причина порожнього вибору. Ті самі правила, що в selectJobs, лише без обмеження «п'ять». */
export function noMatchReason(pool: Pool, profile: DigestProfile, now: Date): NoMatchReason {
  if (profile.roles.length === 0) return { kind: "no_roles" };
  const live = [...pool.company, ...pool.nextrole.filter((j) => isFresh(j, now))];
  const forRoles = live.filter((j) => profile.roles.some((r) => j.roles.includes(r)));
  if (forRoles.length === 0) return { kind: "no_role_jobs", roles: profile.roles };
  const modes = workModes(profile.remoteMode);
  const effective: ReadonlyArray<"remote" | "city"> = modes.length ? modes : ["remote"];
  if (forRoles.some((j) => placeMatch(j, effective, profile.city))) return { kind: "all_sent" };
  if (effective.includes("city") && profile.city) {
    return { kind: "city_only", city: profile.city, remote: forRoles.filter((j) => placeMatch(j, ["remote"], null)).length };
  }
  return { kind: "remote_only", inCities: forRoles.filter((j) => !placeMatch(j, ["remote"], null)).length };
}

export type InstantDeps = {
  db: D1Database;
  env: { SITE_URL?: string };
  jobs: () => JobsDb;
  now: Date;
};

/** Наша база не відповіла на вакансії компаній: підбір іде без них (у журнал попередження). */
async function companyJobs(db: D1Database, env: { SITE_URL?: string }, label: string): Promise<PoolJob[]> {
  try {
    return await loadCompanyJobs(db, env);
  } catch (e) {
    console.warn(`${label}: company jobs read failed (${e instanceof Error ? e.name : "unknown"})`);
    return [];
  }
}

/**
 * До п'яти вакансій для анкети людини, як їх вибрала б добірка зараз. `exclude` = sent.job_ref
 * цієї людини: надіслане раніше не повторюється, як і в добірці.
 */
export async function instantMatches(deps: InstantDeps, brief: BriefRow, exclude: ReadonlySet<string>): Promise<InstantMatches> {
  const profile = profileOf(brief);
  if (profile.roles.length === 0) return { state: "none", reason: { kind: "no_roles" } };
  const [company, crawl] = await Promise.all([companyJobs(deps.db, deps.env, "jobs now"), nextrolePool(deps.jobs, deps.now)]);
  if (!crawl) return { state: "unavailable" };
  const pool: Pool = { nextrole: crawl.map(digestJobOf), company: company.map(digestJobOf) };
  const picks = selectJobs(pool, profile, { now: deps.now, exclude });
  if (picks.length > 0) return { state: "ok", jobs: picks.map(shown) };
  return { state: "none", reason: noMatchReason(pool, profile, deps.now) };
}

// ---------------------------------------------------------------------------
// Головна: приклад добірки й кількість

/**
 * Вигадана анкета для прикладу на головній: п'ять різних ролей, віддалено, від $50k.
 * Добірка бере одну вакансію на роль і на компанію, тож приклад різноманітний, а мінімум
 * зарплати піднімає вгору вакансії з указаною зарплатою (як у справжній добірці).
 */
export const SAMPLE_BRIEF: BriefRow = {
  roles: JSON.stringify(["engineer", "product_manager", "marketing_content", "bd", "trader"] satisfies RoleKey[]),
  remote_mode: "remote",
  city: null,
  salary_min: 50_000,
  salary_currency: "USD",
};

export type TodayJobs = {
  /** false: базу вакансій зараз не прочитали; сторінка показує запасний текст. */
  available: boolean;
  jobs: ShownJob[];
  /** Живих вакансій у пулі (NextRole після сита + компаній). */
  live: number;
  /** Різних джерел: дошки NextRole (jobs_cache.source) і, якщо є, вакансії компаній у нас. */
  sources: number;
};

const UNAVAILABLE: TodayJobs = { available: false, jobs: [], live: 0, sources: 0 };

let today: { at: number; value: TodayJobs } | null = null;

/** Для тестів: наступний виклик рахує знову. */
export function resetTodayJobs(): void {
  today = null;
}

/**
 * Приклад добірки й кількість для головної. Готовий результат живе в пам'яті ізолята
 * POOL_TTL_MS, тож головна читає базу не частіше: пул NextRole раз на 10 хвилин (свій кеш),
 * вакансії компаній раз на 10 хвилин. Невдача (база NextRole не відповіла, попереднього пулу
 * немає) кешується на FAILURE_BACKOFF_MS і дає available: false, а не помилку сторінки.
 */
export async function todayJobs(deps: { db: () => D1Database; env: { SITE_URL?: string }; jobs: () => JobsDb; now: Date }): Promise<TodayJobs> {
  const t = Date.now();
  if (today && t - today.at < (today.value.available ? POOL_TTL_MS : FAILURE_BACKOFF_MS)) return today.value;
  let value: TodayJobs;
  try {
    const crawl = await nextrolePool(deps.jobs, deps.now);
    if (!crawl) {
      value = UNAVAILABLE;
    } else {
      const company = await companyJobs(deps.db(), deps.env, "home");
      const pool: Pool = { nextrole: crawl.map(digestJobOf), company: company.map(digestJobOf) };
      const picks = selectJobs(pool, profileOf(SAMPLE_BRIEF), { now: deps.now, exclude: new Set() });
      const origins = new Set(crawl.map((j) => j.origin).filter((o): o is string => Boolean(o)));
      value = {
        available: true,
        jobs: picks.map(shown),
        live: crawl.length + company.length,
        sources: origins.size + (company.length > 0 ? 1 : 0),
      };
    }
  } catch (e) {
    // Напр. немає прив'язки DB поза Worker: головна однаково відкривається.
    console.warn(`home: today's jobs failed (${e instanceof Error ? e.name : "unknown"})`);
    value = UNAVAILABLE;
  }
  today = { at: Date.now(), value };
  return value;
}

/**
 * Кількість без прикрашання: до 100 точно, далі вниз до десятка чи сотні з «+»
 * (1 909 → «1,900+», 117 → «110+», 40 → «40»). Ніколи не більше, ніж є.
 */
export function roughCount(n: number): string {
  if (n < 100) return String(Math.max(0, Math.floor(n)));
  const step = n < 1000 ? 10 : 100;
  const floor = Math.floor(n / step) * step;
  return `${floor.toLocaleString("en-US")}${floor < n ? "+" : ""}`;
}

/** «1,900+ live crypto jobs from 117 sources, updated daily.»; null, якщо показати нічого. */
export function countLine(t: Pick<TodayJobs, "live" | "sources">): string | null {
  if (t.live <= 0) return null;
  const jobs = `${roughCount(t.live)} live crypto job${t.live === 1 ? "" : "s"}`;
  const from = t.sources > 0 ? ` from ${t.sources} source${t.sources === 1 ? "" : "s"}` : "";
  return `${jobs}${from}, updated daily.`;
}
