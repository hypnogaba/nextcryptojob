import { sqlTime } from "@/lib/time";

/**
 * Лічильники повідомлень воронки й відгуків для /admin/health (аудит 29.09, F): скільки нагадувань,
 * «Still looking?», пауз після тиші, листів «порожній тиждень» і «бот заблокований» пішло, скільки людей
 * відповіло, скільки 👍/👎. Читає nudges і job_feedback (0028). Якщо міграцію ще не накочено, повертає null,
 * і сторінка каже про це, а не падає.
 */

export type NudgeCount = { d7: number; d30: number };

export type FunnelMessages = {
  onboardingReminders: NudgeCount;
  stillLooking: NudgeCount;
  /** Скільки з «Still looking?» отримали відповідь «Yes». */
  stillAnswered: number;
  inactivePaused: NudgeCount;
  emptyWeek: NudgeCount;
  blockedNotices: NudgeCount;
  thumbsUp: number;
  thumbsDown: number;
  /** Скільки різних людей ставили відгук за 30 днів. */
  voters: number;
};

const KIND_SQL = `SELECT kind, SUM(sent_at >= ?1) AS d7, COUNT(*) AS d30, SUM(answered_at IS NOT NULL) AS answered
  FROM nudges WHERE sent_at >= ?2 GROUP BY kind`;
const FEEDBACK_SQL = `SELECT COALESCE(SUM(vote = 'up'), 0) AS up, COALESCE(SUM(vote = 'down'), 0) AS down, COUNT(DISTINCT user_id) AS voters
  FROM job_feedback WHERE at >= ?1`;

export async function loadFunnelMessages(d: D1Database, now: Date = new Date()): Promise<FunnelMessages | null> {
  const day = 86_400_000;
  try {
    const [kinds, feedback] = await d.batch([
      d.prepare(KIND_SQL).bind(sqlTime(new Date(now.getTime() - 7 * day)), sqlTime(new Date(now.getTime() - 30 * day))),
      d.prepare(FEEDBACK_SQL).bind(sqlTime(new Date(now.getTime() - 30 * day))),
    ]);
    const by = new Map((kinds.results as Array<{ kind: string; d7: number; d30: number; answered: number }>).map((r) => [r.kind, r]));
    const count = (k: string): NudgeCount => ({ d7: by.get(k)?.d7 ?? 0, d30: by.get(k)?.d30 ?? 0 });
    const f = (feedback.results as Array<{ up: number; down: number; voters: number }>)[0] ?? { up: 0, down: 0, voters: 0 };
    return {
      onboardingReminders: count("onboarding_reminder"),
      stillLooking: count("still_looking"),
      stillAnswered: by.get("still_looking")?.answered ?? 0,
      inactivePaused: count("inactive_pause"),
      emptyWeek: count("empty_week"),
      blockedNotices: count("tg_blocked_notice"),
      thumbsUp: f.up,
      thumbsDown: f.down,
      voters: f.voters,
    };
  } catch (err) {
    if (err instanceof Error && /no such table/i.test(err.message)) return null;
    throw err;
  }
}
