// Внутрішня сторінка /jobs/<id> для вакансій зі сканування (раунд 5, п.20): досі клік з картки
// вів одразу на зовнішню дошку; тепер уся картка веде сюди, "Apply" лишається зовнішнім.
// jobs_cache (db/jobs 0001_schema.sql) не має опису вакансії (сканер його не зберігає, лише
// метадані), тож сторінка показує те, що є: компанію, місце, зарплату, токен, теги, причини
// підбору (коли людина ввійшла й підходить), і веде далі на джерело кнопкою Apply.
import { cleanText, formatSalary, safeUrl } from "@/lib/digest/format";
import { type CompanyProfiles, profileFor } from "./companies";
import { brandKey } from "./clean";
import type { JobsDb } from "@/lib/jobs-db";
import { jobVia } from "./link";
import { ATS_WINDOW_DAYS, isEmployerFeed, parseDbTime, POSTED_WINDOW_DAYS } from "./pool";
import { ROLE_NAMES, titleRoles } from "./roles";
import type { RoleKey } from "@/lib/card/roles";
import { companySiteUrl, tokenChip, type TokenChip } from "./token";
import { freshnessLine } from "./freshness";

/** id вакансій зі сканування: 'j' + 24 hex від sha256(url) (db/jobs/0001_schema.sql). */
const SCANNED_ID = /^j[0-9a-f]{24}$/i;

export function isScannedJobId(value: unknown): value is string {
  return typeof value === "string" && SCANNED_ID.test(value);
}

type Row = {
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
  source: string;
  tags: string;
  posted_at: string | null;
  first_seen_at: string;
  fetched_at: string;
  country: string | null;
};

export type ScannedJobPage = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  remote: boolean;
  country: string | null;
  salary: string | null;
  roleNames: string[];
  postedAt: string | null;
  url: string | null;
  site: string | null;
  about: string | null;
  token: TokenChip | null;
  via: string | null;
  /** «Posted Sep 3. Still open on Sep 17.» (freshness.ts). */
  freshness: string | null;
};

function tagsOf(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/** Джерело read-only лише через jobs.all у викликача (лишається сумісним із eslint jobs-db). */
export async function loadScannedJob(jobs: JobsDb, id: string, profiles: CompanyProfiles, now: Date = new Date()): Promise<ScannedJobPage | null> {
  if (!isScannedJobId(id)) return null;
  const rows = await jobs.all<Row>(
    `SELECT id, url, company, company_key, title, location, remote, salary_min, salary_max, salary_currency,
            source, tags, posted_at, first_seen_at, fetched_at, country
       FROM jobs_cache WHERE id = ?`,
    id,
  );
  const row = rows[0];
  if (!row) return null;

  // Жива: та сама межа віку, що для добірки (engine/src/digest/jobs.ts): ATS_WINDOW_DAYS для
  // власного фіду роботодавця, інакше POSTED_WINDOW_DAYS від публікації чи першої появи в скані.
  const ageDays = isEmployerFeed(row.source) ? ATS_WINDOW_DAYS : POSTED_WINDOW_DAYS;
  const anchor = new Date(row.posted_at ?? row.first_seen_at);
  const ageMs = now.getTime() - anchor.getTime();
  if (!Number.isFinite(ageMs) || ageMs > ageDays * 86_400_000) return null;

  const tags = tagsOf(row.tags);
  const roles: RoleKey[] = titleRoles(row.title, tags);
  const known = profileFor(profiles, brandKey(row.company));
  const site = known?.domain ? companySiteUrl(known.domain) : null;
  const url = safeUrl(row.url);

  return {
    id: row.id,
    title: cleanText(row.title, 200),
    company: cleanText(row.company, 100),
    location: row.location?.trim() ? cleanText(row.location, 100) : row.remote === 1 ? "Remote" : null,
    remote: row.remote === 1,
    country: row.country,
    salary: formatSalary({ min: row.salary_min, max: row.salary_max, currency: row.salary_currency, period: "year" }),
    roleNames: roles.map((r) => ROLE_NAMES[r]),
    postedAt: row.posted_at,
    url,
    site,
    about: known?.about ?? null,
    token: tokenChip(known?.token, now),
    via: jobVia(url),
    freshness: freshnessLine(
      { postedMs: parseDbTime(row.posted_at), firstSeenMs: parseDbTime(row.first_seen_at), checkedMs: parseDbTime(row.fetched_at) },
      now,
    ),
  };
}
