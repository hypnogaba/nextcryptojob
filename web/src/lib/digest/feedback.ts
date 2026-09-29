import { hmacSha256Hex, hmacSha256Verify } from "@/lib/auth/hash";
import { brandKey } from "@/lib/jobs/clean";
import type { JobsDb } from "@/lib/jobs-db";

/**
 * Відгук на вакансію з добірки (аудит 29.09, F2): 👍/👎 у Telegram (bot.ts, `fb:u:<ref>` / `fb:d:<ref>`)
 * і «Not for me» у листі (підписане посилання, /api/digest/feedback). Один голос на пару (людина, вакансія):
 * job_feedback UNIQUE(user_id, job_ref), повторний голос міняє попередній.
 *
 * 👎 на 30 днів прибирає з добірки цієї людини всі вакансії тієї самої компанії (engine
 * schedule.ts dislikedCompanies). Ключ компанії пишемо тут (brandKey, як companyKey вакансії в підборі);
 * не вдалося дізнатись: NULL, і рушій візьме його з пулу за job_ref.
 * Голосувати можна лише за вакансію, яку ми цій людині надсилали (sent).
 */

export const FEEDBACK_PATH = "/api/digest/feedback";
/** Скільки днів 👎 тримає компанію поза добіркою (те саме число в engine DISLIKE_DAYS). */
export const DISLIKE_DAYS = 30;

export type Vote = "up" | "down";

/** Причини зі сторінки листа; ключ лягає в job_feedback.reason. */
export const FEEDBACK_REASONS = {
  wrong_role: "Not my kind of role",
  wrong_level: "Wrong level (too senior or too junior)",
  wrong_place: "Wrong place or remote rules",
  low_pay: "Pay is too low",
  other: "Something else",
} as const;
export type FeedbackReason = keyof typeof FEEDBACK_REASONS;

export function isReason(value: unknown): value is FeedbackReason {
  return typeof value === "string" && Object.hasOwn(FEEDBACK_REASONS, value);
}

/** 'nr:<id>' або 'co:<id>'; id як в базах, без пробілів і розділових знаків. */
export const JOB_REF = /^(nr|co):[A-Za-z0-9_-]{1,64}$/;

/** Ключ вакансії з рядка добірки: сайт бере його з source і job_id (engine його окремо не шле). */
export function jobRefOf(source: "nextrole" | "company", jobId: string | null | undefined): string | null {
  if (!jobId) return null;
  const ref = `${source === "company" ? "co" : "nr"}:${jobId}`;
  return JOB_REF.test(ref) ? ref : null;
}

const message = (userId: string, ref: string) => `fb:${userId}:${ref}`;

/** Підписане посилання «Not for me» для однієї вакансії однієї людини. */
export async function feedbackUrl(site: string, key: string, userId: string, ref: string): Promise<string> {
  const url = new URL(FEEDBACK_PATH, site);
  url.searchParams.set("u", userId);
  url.searchParams.set("j", ref);
  url.searchParams.set("t", await hmacSha256Hex(key, message(userId, ref)));
  return url.toString();
}

/** Людина й вакансія з адреси, якщо підпис збігся (за сталий час), інакше null. */
export async function verifyFeedback(key: string, params: URLSearchParams): Promise<{ userId: string; ref: string } | null> {
  const userId = params.get("u") ?? "";
  const ref = params.get("j") ?? "";
  const token = params.get("t") ?? "";
  if (userId.length === 0 || userId.length > 64 || !JOB_REF.test(ref) || !/^[0-9a-f]{64}$/i.test(token)) return null;
  return (await hmacSha256Verify(key, message(userId, ref), token)) ? { userId, ref } : null;
}

/** Ключ компанії вакансії зі сканування; null, якщо бази вакансій немає чи вакансії вже нема. */
async function companyKeyOf(jobs: JobsDb | null, ref: string): Promise<string | null> {
  if (!jobs || !ref.startsWith("nr:")) return null;
  try {
    const row = await jobs.first<{ company_key: string | null; company: string }>(
      "SELECT company_key, company FROM jobs_cache WHERE id = ?",
      ref.slice(3),
    );
    if (!row) return null;
    return row.company_key ? brandKey(row.company_key) : brandKey(row.company);
  } catch {
    // Ключ не обов'язковий: рушій знайде компанію в пулі за job_ref.
    return null;
  }
}

export type FeedbackResult = "saved" | "bad_ref" | "unknown_job";

export async function recordFeedback(
  d: D1Database,
  jobs: JobsDb | null,
  userId: string,
  ref: string,
  vote: Vote,
  reason: FeedbackReason | null = null,
): Promise<FeedbackResult> {
  if (!JOB_REF.test(ref)) return "bad_ref";
  const shown = await d.prepare("SELECT 1 AS yes FROM sent WHERE user_id = ? AND job_ref = ? LIMIT 1").bind(userId, ref).first<{ yes: number }>();
  if (!shown) return "unknown_job";
  const companyKey = vote === "down" ? await companyKeyOf(jobs, ref) : null;
  await d.batch([
    d
      .prepare(
        `INSERT INTO job_feedback (user_id, job_ref, vote, reason, company_key) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (user_id, job_ref) DO UPDATE
            SET vote = excluded.vote, reason = excluded.reason,
                company_key = COALESCE(excluded.company_key, job_feedback.company_key), at = datetime('now')`,
      )
      .bind(userId, ref, vote, vote === "down" ? reason : null, companyKey),
    // Відгук це теж «людина тут»: рахується проти нагадування «Still looking?».
    d.prepare("UPDATE users SET last_active_at = datetime('now') WHERE id = ?").bind(userId),
  ]);
  return "saved";
}
