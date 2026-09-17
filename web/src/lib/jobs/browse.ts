import { isRoleKey, type RoleKey } from "@/lib/card/roles";
import { compare, loadCompanyJobs, matches } from "@/lib/crm/public-jobs";
import { estimateText } from "@/lib/digest/format";
import type { JobsDb } from "@/lib/jobs-db";
import { type CompanyProfiles, companyProfiles, profileFor } from "./companies";
import { freshnessLine } from "./freshness";
import { digestJobOf, type ShownJob } from "./instant";
import { formatSalary } from "./match";
import { crawlPool, type PoolJob } from "./pool";
import { tokenChip } from "./token";

/**
 * «All jobs» (власник 16.09, j5): пошук по ВСІХ живих вакансіях, не лише п'яти надісланих, і дані
 * компанії поруч (токен, ціна, капіталізація, скільки в неї відкритих позицій).
 *
 * Пул той самий, що в добірці й search_jobs (pool.ts: пам'ять ізолята, база вакансій не читається на
 * кожен пошук), фільтр і порядок ті самі, що в search_jobs (crm/public-jobs.ts). Лише читання.
 */

export const BROWSE_PAGE_SIZE = 20;
/** Найдовший пошуковий рядок; довше обрізаємо. */
const MAX_Q = 100;

export type BrowseInput = {
  q: string;
  role: RoleKey | null;
  remote: boolean;
  /** Ключ компанії (PoolJob.companyKey): «усі позиції цієї компанії». */
  company: string | null;
  page: number;
};

export type BrowseJob = ShownJob & {
  /** Скільки живих позицій у цієї компанії в усьому пулі. */
  openRoles: number;
  companyKey: string;
};

export type BrowseResult =
  | { state: "ok"; jobs: BrowseJob[]; total: number; page: number; pages: number; companyName: string | null }
  | { state: "unavailable" };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/** Параметри адреси → фільтри. Криве значення = без фільтра, а не помилка. */
export function browseInputOf(params: Record<string, string | string[] | undefined>): BrowseInput {
  const role = first(params.role);
  const page = Number.parseInt(first(params.page), 10);
  const company = first(params.company).trim().toLowerCase();
  return {
    q: first(params.q).trim().slice(0, MAX_Q),
    role: isRoleKey(role) ? role : null,
    remote: first(params.remote) === "1",
    company: company && company.length <= 100 ? company : null,
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}

/** Адреса сторінки з тими самими фільтрами й іншими змінами (сторінка, компанія). */
export function browseHref(input: BrowseInput, over: Partial<BrowseInput> = {}): string {
  const v = { ...input, ...over };
  const p = new URLSearchParams();
  if (v.q) p.set("q", v.q);
  if (v.role) p.set("role", v.role);
  if (v.remote) p.set("remote", "1");
  if (v.company) p.set("company", v.company);
  if (v.page > 1) p.set("page", String(v.page));
  const qs = p.toString();
  return qs ? `/jobs/all?${qs}` : "/jobs/all";
}

function card(job: PoolJob, openRoles: number, profiles: CompanyProfiles, now: Date): BrowseJob {
  const j = digestJobOf(job);
  const company = job.source === "company";
  const salary = formatSalary(j.salary);
  const known = company ? null : profileFor(profiles, job.companyKey, job.company);
  return {
    ref: j.ref,
    title: j.title,
    company: j.company,
    location: j.location,
    salary,
    why: "",
    url: j.url,
    postedBy: company ? j.company : null,
    salaryEstimate: salary ? null : estimateText(job.salaryEstimate),
    reasons: [],
    note: null,
    about: known?.about ?? null,
    domain: known?.domain ?? null,
    token: tokenChip(known?.token, now),
    freshness: freshnessLine({ postedMs: j.postedAt, firstSeenMs: j.firstSeenAt, checkedMs: company ? now.getTime() : j.seenAt }, now),
    openRoles,
    companyKey: job.companyKey,
  };
}

export async function browseJobs(
  deps: { db: D1Database; env: { SITE_URL?: string }; jobs: () => JobsDb; now: Date },
  input: BrowseInput,
): Promise<BrowseResult> {
  const [company, crawl, profiles] = await Promise.all([
    loadCompanyJobs(deps.db, deps.env).catch((e: unknown) => {
      console.warn(`jobs all: company jobs read failed (${e instanceof Error ? e.name : "unknown"})`);
      return [] as PoolJob[];
    }),
    crawlPool(deps.jobs, deps.now),
    companyProfiles(deps.jobs),
  ]);
  if (!crawl) return { state: "unavailable" };
  const pool = [...company, ...crawl];
  const perCompany = new Map<string, number>();
  for (const j of pool) perCompany.set(j.companyKey, (perCompany.get(j.companyKey) ?? 0) + 1);

  const found = pool
    .filter((j) => (input.company ? j.companyKey === input.company : true))
    .filter((j) => matches(j, { q: input.q || undefined, role: input.role ?? undefined, work_mode: input.remote ? "remote" : undefined }))
    .sort(compare);
  const pages = Math.max(1, Math.ceil(found.length / BROWSE_PAGE_SIZE));
  const page = Math.min(input.page, pages);
  const slice = found.slice((page - 1) * BROWSE_PAGE_SIZE, page * BROWSE_PAGE_SIZE);
  const companyName = input.company ? (pool.find((j) => j.companyKey === input.company)?.company ?? null) : null;
  return {
    state: "ok",
    jobs: slice.map((j) => card(j, perCompany.get(j.companyKey) ?? 1, profiles, deps.now)),
    total: found.length,
    page,
    pages,
    companyName,
  };
}
