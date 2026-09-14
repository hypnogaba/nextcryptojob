import type { JobsDb } from "@/lib/jobs-db";
import type { BriefRow } from "@/lib/jobs/instant";
import { normalizeSavedStep, parseSavedStep, type SavedStep } from "@/lib/onboarding/steps";
import type { Channel } from "@/lib/telegram/channel";
import { salaryEstimateOf } from "@/lib/jobs/pool";
import { cleanText, companyJobLocation, estimateText, formatSalary, safeUrl } from "./format";

/**
 * Дані сторінки /jobs: вакансії, які добірка вже надіслала людині (`sent`, 0006),
 * і стан налаштувань для порожньої сторінки.
 *
 * Читання дешеві: людина й її добірки двома запитами до нашої бази, потім по
 * одному запиту на джерело з IN (...) лише за вікно HISTORY_DAYS і не більше
 * HISTORY_LIMIT посилань (менше за межу D1 у 100 параметрів на запит).
 * Кожен запит до `sent` і `digest_runs` обмежено user_id людини з сесії.
 * Збій нашої бази на історії чи вакансіях компаній не валить сторінку: вона
 * каже, що зараз не вийшло (historyError або state 'unavailable').
 */

export const HISTORY_DAYS = 14;
/** 14 днів по 5 вакансій. */
export const HISTORY_LIMIT = 70;
/**
 * Скільки надісланих посилань читаємо, щоб «Jobs for you now» не повторював надісланого
 * (добірка engine виключає всі). Індекс idx_sent_user (user_id, created_at): читання =
 * повернуті рядки. 1 000 це понад пів року щоденних добірок, а пул вакансій тримає лише
 * вакансії за 30 днів, тож давніші посилання однаково не збіглися б.
 */
export const EXCLUDE_LIMIT = 1000;

export type JobDetails = {
  title: string;
  company: string;
  location: string | null;
  salary: string | null;
  /**
   * http(s) або mailto (вакансії зі сканування); для вакансій компаній їхня сторінка на
   * сайті `/jobs/<id>` (звідти "Apply" рахує перехід); null, якщо адреса непридатна.
   */
  url: string | null;
  /** Для вакансій компаній: «Posted by {Company} on NextCryptoJob». */
  postedBy: string | null;
  /** Оцінка дошки підписом («est. … (web3.career estimate)»), лише без зарплати; null для решти. */
  salaryEstimate?: string | null;
};

export type SentJob = {
  ref: string;
  source: "nextrole" | "company";
  why: string | null;
  /** gone: вакансії вже немає в джерелі; unavailable: джерело зараз не прочитали. */
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

export type JobsPage = {
  setup: DigestSetup;
  /** Анкета людини для «Jobs for you now» (lib/jobs/instant.ts). */
  brief: BriefRow;
  /** Досягнутий крок анкети (як loadAnswers): чи показувати «Stand out to companies». */
  step: SavedStep;
  /** sent.job_ref цієї людини, будь-який статус; порожньо, якщо історію не прочитали. */
  sentRefs: ReadonlySet<string>;
  digests: SentDigest[];
  /** Історію з нашої бази зараз не прочитали: сторінка просить спробувати пізніше. */
  historyError: boolean;
};

type UserRow = BriefRow & {
  email: string | null;
  telegram_id: string | null;
  channel: Channel;
  digest_hour: number;
  timezone: string | null;
  digest_paused: number;
  onboarding_step: string | null;
  scoring: number | null;
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
  salary_est_min: number | null;
  salary_est_max: number | null;
  salary_est_currency: string | null;
  source: string | null;
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

const errorName = (e: unknown) => (e instanceof Error ? e.name : "unknown");

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

/** Надіслані вакансії й останній прогін людини; null, якщо база зараз не відповіла. */
async function digestRows(
  d: D1Database,
  userId: string,
): Promise<{ sent: SentRow[]; lastRun: RunStatus | null; refs: Set<string> } | null> {
  try {
    const [sent, last, refs] = await d.batch([
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
      d.prepare("SELECT job_ref FROM sent WHERE user_id = ? ORDER BY created_at DESC LIMIT ?").bind(userId, EXCLUDE_LIMIT),
    ]);
    const lastRow = (last.results as { status: RunStatus }[])[0];
    return {
      sent: sent.results as SentRow[],
      lastRun: lastRow?.status ?? null,
      refs: new Set((refs.results as { job_ref: string }[]).map((r) => r.job_ref)),
    };
  } catch (e) {
    console.warn(`jobs page: history read failed (${errorName(e)})`);
    return null;
  }
}

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

async function crawlDetails(jobs: JobsDb, ids: string[]): Promise<Map<string, JobDetails> | null> {
  if (ids.length === 0) return new Map();
  let rows: NrRow[];
  try {
    rows = await jobs.all<NrRow>(
      `SELECT id, url, company, title, location, remote, salary_min, salary_max, salary_currency,
              salary_est_min, salary_est_max, salary_est_currency, source
         FROM jobs_cache WHERE id IN (${placeholders(ids.length)})`,
      ...ids,
    );
  } catch (e) {
    // База вакансій не відповіла (429 чи збій): сторінка лишається, без подробиць.
    console.warn(`jobs page: JOBS_DB read failed (${errorName(e)})`);
    return null;
  }
  return new Map(
    rows.map((r) => {
      const estimate = estimateText(salaryEstimateOf(r));
      return [
      `nr:${r.id}`,
      {
        title: cleanText(r.title, 200),
        company: cleanText(r.company, 100),
        location: r.location?.trim() ? cleanText(r.location, 100) : r.remote === 1 ? "Remote" : null,
        salary: formatSalary({ min: r.salary_min, max: r.salary_max, currency: r.salary_currency, period: "year" }),
        url: safeUrl(r.url),
        postedBy: null,
        ...(estimate ? { salaryEstimate: estimate } : {}),
      },
      ];
    }),
  );
}

async function companyDetails(d: D1Database, ids: string[]): Promise<Map<string, JobDetails> | null> {
  if (ids.length === 0) return new Map();
  // Закриту вакансію показуємо, приховану адміном ні.
  let results: CoRow[];
  try {
    ({ results } = await d
      .prepare(
        `SELECT j.id, j.title, j.remote_mode, j.city, j.salary_min, j.salary_max, j.salary_currency,
                j.salary_period, c.name AS company_name
           FROM company_jobs j JOIN companies c ON c.id = j.company_id
          WHERE j.id IN (${placeholders(ids.length)}) AND j.hidden_by_admin_at IS NULL`,
      )
      .bind(...ids)
      .all<CoRow>());
  } catch (e) {
    console.warn(`jobs page: company jobs read failed (${errorName(e)})`);
    return null;
  }
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
          // Сторінка вакансії: жива показує "Apply", закрита каже "This job is closed."
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
        `SELECT email, telegram_id, channel, digest_hour, timezone, digest_paused,
                roles, remote_mode, city, salary_min, salary_currency, role_text, onboarding_step,
                (SELECT granted FROM consents WHERE user_id = users.id AND kind = 'scoring') AS scoring
           FROM users WHERE id = ?`,
      )
      .bind(userId)
      .first<UserRow>(),
    digestRows(d, userId),
  ]);
  if (!user) return null;
  const sent = history?.sent ?? [];

  const setup: DigestSetup = {
    paused: user.digest_paused === 1,
    channel: channelOf(user),
    hasRoles: hasRoles(user.roles),
    hour: user.digest_hour,
    timezone: user.timezone || "UTC",
    lastRun: history?.lastRun ?? null,
  };

  const refs = (prefix: string) =>
    [...new Set(sent.filter((s) => s.job_ref.startsWith(prefix)).map((s) => s.job_ref.slice(prefix.length)))];
  // 'nr:' це вакансія зі сканування (мітка з часів NextRole, sent.job_ref). Посилання, надіслані до
  // 14.09.2026, вказують на id старої бази: у новій їх немає, тож вони показуються як «gone».
  const [nr, co] = await Promise.all([crawlDetails(jobs, refs("nr:")), companyDetails(d, refs("co:"))]);

  const digests: SentDigest[] = [];
  for (const s of sent) {
    let digest = digests.at(-1);
    if (!digest || digest.digestId !== s.digest_id) {
      digest = { digestId: s.digest_id, localDate: s.local_date, channel: s.channel, jobs: [] };
      digests.push(digest);
    }
    const source = s.job_ref.startsWith("nr:") ? nr : co;
    const details = source?.get(s.job_ref) ?? null;
    const state = details ? "ok" : source === null ? "unavailable" : "gone";
    digest.jobs.push({ ref: s.job_ref, source: s.source, why: s.why ? cleanText(s.why, 300) : null, state, details });
  }
  const brief: BriefRow = {
    roles: user.roles,
    remote_mode: user.remote_mode,
    city: user.city,
    salary_min: user.salary_min,
    salary_currency: user.salary_currency,
    role_text: user.role_text ?? null,
  };
  const step = normalizeSavedStep(parseSavedStep(user.onboarding_step), user.scoring === 1);
  return { setup, brief, step, sentRefs: history?.refs ?? new Set(), digests, historyError: history === null };
}
