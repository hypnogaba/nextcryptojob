import type { JobsDb } from "@/lib/jobs-db";
import type { Channel } from "@/lib/telegram/channel";
import { cleanText, companyJobLocation, formatSalary, safeUrl } from "./format";

/**
 * Дані сторінки /jobs: вакансії, які добірка вже надіслала людині (`sent`, 0006),
 * і стан налаштувань для порожньої сторінки.
 *
 * Читання дешеві: людина й її добірки двома запитами до нашої бази, потім по
 * одному запиту на джерело з IN (...) лише за вікно HISTORY_DAYS і не більше
 * HISTORY_LIMIT посилань (менше за межу D1 у 100 параметрів на запит).
 * Кожен запит до `sent` і `digest_runs` обмежено user_id людини з сесії.
 */

export const HISTORY_DAYS = 14;
/** 14 днів по 5 вакансій. */
export const HISTORY_LIMIT = 70;

export type JobDetails = {
  title: string;
  company: string;
  location: string | null;
  salary: string | null;
  /** http(s) або шлях на сайті; null, якщо адреса з джерела непридатна. */
  url: string | null;
  /** Для вакансій компаній: «Posted by {Company} on NextCryptoJob». */
  postedBy: string | null;
};

export type SentJob = {
  ref: string;
  source: "nextrole" | "company";
  why: string | null;
  /** gone: вакансії вже немає в джерелі; unavailable: базу вакансій зараз не прочитали. */
  state: "ok" | "gone" | "unavailable";
  details: JobDetails | null;
};

export type SentDigest = {
  digestId: string;
  /** YYYY-MM-DD у поясі людини. */
  localDate: string;
  channel: Channel | null;
  jobs: SentJob[];
};

export type RunStatus = "pending" | "sent" | "failed" | "empty";

export type DigestSetup = {
  paused: boolean;
  /** Куди піде добірка, як вирішує engine (planChannel): свій канал, інакше той, що є. */
  channel: Channel | null;
  hasRoles: boolean;
  hour: number;
  timezone: string;
  /** Стан останньої добірки людини; null, якщо її ще не було. */
  lastRun: RunStatus | null;
};

export type JobsPage = { setup: DigestSetup; digests: SentDigest[] };

type UserRow = {
  email: string | null;
  telegram_id: string | null;
  channel: Channel;
  digest_hour: number;
  timezone: string | null;
  digest_paused: number;
  roles: string;
};

type SentRow = {
  job_ref: string;
  source: "nextrole" | "company";
  digest_id: string;
  position: number;
  why: string | null;
  channel: Channel | null;
  local_date: string;
};

type NrRow = {
  id: string;
  url: string;
  company: string;
  title: string;
  location: string | null;
  remote: number;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
};

type CoRow = {
  id: string;
  title: string;
  remote_mode: string;
  city: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  salary_period: string | null;
  company_name: string;
};

const isMissingTable = (e: unknown) => e instanceof Error && /no such table/i.test(e.message);

function hasRoles(json: string): boolean {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) && v.length > 0;
  } catch {
    return false;
  }
}

function channelOf(u: UserRow): Channel | null {
  if (u.channel === "telegram" && u.telegram_id) return "telegram";
  if (u.email) return "email";
  return u.telegram_id ? "telegram" : null;
}

/**
 * Надіслані вакансії й останній прогін людини. Поки 0006 не накочено, таблиць
 * добірки немає: тоді історії просто ще нема, сторінка не падає.
 */
async function digestRows(d: D1Database, userId: string): Promise<{ sent: SentRow[]; lastRun: RunStatus | null }> {
  try {
    const [sent, last] = await d.batch([
      d
        .prepare(
          `SELECT s.job_ref, s.source, s.digest_id, s.position, s.why, s.channel, r.local_date
             FROM sent s JOIN digest_runs r ON r.id = s.digest_id AND r.user_id = s.user_id
            WHERE s.user_id = ? AND s.status = 'sent' AND s.created_at >= datetime('now', ?)
            ORDER BY r.local_date DESC, s.digest_id DESC, s.position
            LIMIT ?`,
        )
        .bind(userId, `-${HISTORY_DAYS} days`, HISTORY_LIMIT),
      d.prepare("SELECT status FROM digest_runs WHERE user_id = ? ORDER BY local_date DESC LIMIT 1").bind(userId),
    ]);
    const lastRow = (last.results as { status: RunStatus }[])[0];
    return { sent: sent.results as SentRow[], lastRun: lastRow?.status ?? null };
  } catch (e) {
    if (isMissingTable(e)) return { sent: [], lastRun: null };
    throw e;
  }
}

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

async function nextroleDetails(jobs: JobsDb, ids: string[]): Promise<Map<string, JobDetails> | null> {
  if (ids.length === 0) return new Map();
  let rows: NrRow[];
  try {
    rows = await jobs.all<NrRow>(
      `SELECT id, url, company, title, location, remote, salary_min, salary_max, salary_currency
         FROM jobs_cache WHERE id IN (${placeholders(ids.length)})`,
      ...ids,
    );
  } catch (e) {
    // База NextRole чужа й буває зайнята (429): сторінка лишається, без подробиць.
    console.warn(`jobs page: JOBS_DB read failed (${e instanceof Error ? e.name : "unknown"})`);
    return null;
  }
  return new Map(
    rows.map((r) => [
      `nr:${r.id}`,
      {
        title: cleanText(r.title, 200),
        company: cleanText(r.company, 100),
        location: r.location?.trim() ? cleanText(r.location, 100) : r.remote === 1 ? "Remote" : null,
        salary: formatSalary({ min: r.salary_min, max: r.salary_max, currency: r.salary_currency, period: "year" }),
        url: safeUrl(r.url),
        postedBy: null,
      },
    ]),
  );
}

async function companyDetails(d: D1Database, ids: string[]): Promise<Map<string, JobDetails>> {
  if (ids.length === 0) return new Map();
  // Закриту вакансію показуємо (її сторінка скаже, що набір завершено), приховану адміном ні.
  const { results } = await d
    .prepare(
      `SELECT j.id, j.title, j.remote_mode, j.city, j.salary_min, j.salary_max, j.salary_currency, j.salary_period,
              c.name AS company_name
         FROM company_jobs j JOIN companies c ON c.id = j.company_id
        WHERE j.id IN (${placeholders(ids.length)}) AND j.hidden_by_admin_at IS NULL`,
    )
    .bind(...ids)
    .all<CoRow>();
  return new Map(
    results.map((r) => {
      const company = cleanText(r.company_name, 100);
      return [
        `co:${r.id}`,
        {
          title: cleanText(r.title, 200),
          company,
          location: companyJobLocation(r.remote_mode, r.city),
          salary: formatSalary({
            min: r.salary_min,
            max: r.salary_max,
            currency: r.salary_currency,
            period: r.salary_period === "month" ? "month" : "year",
          }),
          url: `/jobs/${encodeURIComponent(r.id)}`,
          postedBy: company,
        },
      ];
    }),
  );
}

/** Усе для сторінки /jobs однієї людини; null, якщо людини вже немає. */
export async function loadJobsPage(d: D1Database, jobs: JobsDb, userId: string): Promise<JobsPage | null> {
  const [user, history] = await Promise.all([
    d
      .prepare(
        `SELECT email, telegram_id, channel, digest_hour, timezone, digest_paused, roles
           FROM users WHERE id = ?`,
      )
      .bind(userId)
      .first<UserRow>(),
    digestRows(d, userId),
  ]);
  if (!user) return null;

  const setup: DigestSetup = {
    paused: user.digest_paused === 1,
    channel: channelOf(user),
    hasRoles: hasRoles(user.roles),
    hour: user.digest_hour,
    timezone: user.timezone || "UTC",
    lastRun: history.lastRun,
  };

  const refs = (prefix: string) =>
    [...new Set(history.sent.filter((s) => s.job_ref.startsWith(prefix)).map((s) => s.job_ref.slice(prefix.length)))];
  const [nr, co] = await Promise.all([nextroleDetails(jobs, refs("nr:")), companyDetails(d, refs("co:"))]);

  const digests: SentDigest[] = [];
  for (const s of history.sent) {
    let digest = digests.at(-1);
    if (!digest || digest.digestId !== s.digest_id) {
      digest = { digestId: s.digest_id, localDate: s.local_date, channel: s.channel, jobs: [] };
      digests.push(digest);
    }
    const isNr = s.job_ref.startsWith("nr:");
    const details = (isNr ? nr?.get(s.job_ref) : co.get(s.job_ref)) ?? null;
    const state = details ? "ok" : isNr && nr === null ? "unavailable" : "gone";
    digest.jobs.push({ ref: s.job_ref, source: s.source, why: s.why ? cleanText(s.why, 300) : null, state, details });
  }
  return { setup, digests };
}
