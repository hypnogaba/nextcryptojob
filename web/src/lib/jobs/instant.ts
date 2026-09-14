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
} from "./match";
import { estimateText } from "@/lib/digest/format";
import { crawlPool, type PoolJob } from "./pool";
import { parseRoles, ROLE_NAMES } from "./roles";

/**
 * «Jobs for you now» на /jobs: вакансії «зараз» для людини з сесії одразу після анкети,
 * тими самими правилами, що й щоденна добірка engine.
 *
 * Правила не свої: selectJobs і решта з match.ts (дослівна копія engine/src/digest/match.ts),
 * пул той самий, що в search_jobs (pool.ts, пам'ять ізолята POOL_TTL_MS) плюс живі
 * вакансії компаній (company_jobs_live, одне читання, не більше COMPANY_POOL_CAP рядків).
 * Сторінка нічого не пише: вибір «зараз» не займає місця в добірці й не рахується як надісланий.
 */

/** Вакансія, як її показати людині (сторінка /jobs). */
export type ShownJob = {
  /** 'nr:<id>' або 'co:<id>', як sent.job_ref. */
  ref: string;
  title: string;
  company: string;
  location: string | null;
  salary: string | null;
  why: string;
  /** Вакансія компанії: її сторінка на сайті /jobs/<id>; зі сканування: http(s) чи mailto; null, якщо адреса крива. */
  url: string | null;
  /** «Posted by {Company} on NextCryptoJob» для вакансій компаній. */
  postedBy: string | null;
  /** «est. $Xk to $Yk (web3.career estimate)»: оцінка дошки, лише без зарплати; у підборі не бере участі. */
  salaryEstimate: string | null;
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

/** Вакансія пулу сайту → вакансія добірки (як crawlJob і companyJob в engine/src/digest/jobs.ts). */
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

function shown(pick: DigestPick, estimates: ReadonlyMap<string, string>): ShownJob {
  const j = pick.job;
  const company = j.source === "company";
  const salary = formatSalary(j.salary);
  return {
    ref: j.ref,
    title: j.title,
    company: j.company,
    location: j.location,
    salary,
    why: pick.why,
    url: j.url,
    postedBy: company ? j.company : null,
    salaryEstimate: salary ? null : (estimates.get(j.ref) ?? null),
  };
}

type Pool = { crawl: DigestJob[]; company: DigestJob[] };

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
  /** Базу вакансій зараз не прочитали (і попереднього пулу в ізоляті немає). */
  | { state: "unavailable" };

/** Людська назва кількох ролей: «Engineer», «Engineer or Trader», «Engineer, DevRel or Trader». */
export function roleList(roles: readonly RoleKey[]): string {
  const names = roles.map((r) => ROLE_NAMES[r]);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

/** Причина порожнього вибору. Ті самі правила, що в selectJobs, лише без обмеження «п'ять». */
export function noMatchReason(pool: Pool, profile: DigestProfile, now: Date): NoMatchReason {
  if (profile.roles.length === 0) return { kind: "no_roles" };
  const live = [...pool.company, ...pool.crawl.filter((j) => isFresh(j, now))];
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
  const [company, crawl] = await Promise.all([companyJobs(deps.db, deps.env, "jobs now"), crawlPool(deps.jobs, deps.now)]);
  if (!crawl) return { state: "unavailable" };
  const pool: Pool = { crawl: crawl.map(digestJobOf), company: company.map(digestJobOf) };
  const picks = selectJobs(pool, profile, { now: deps.now, exclude });
  // Оцінки дошки поза DigestJob: підбір їх не бачить, лише підпис поруч із вибраним.
  const estimates = new Map<string, string>();
  for (const j of crawl) {
    const text = estimateText(j.salaryEstimate);
    if (text) estimates.set(digestJobOf(j).ref, text);
  }
  if (picks.length > 0) return { state: "ok", jobs: picks.map((p) => shown(p, estimates)) };
  return { state: "none", reason: noMatchReason(pool, profile, deps.now) };
}

// ---------------------------------------------------------------------------
// Кількість

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
