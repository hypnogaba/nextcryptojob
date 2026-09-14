// Черга рушія балу (docs/contracts.md, §5). Сайт лише додає рядок 'queued';
// забирає й рахує рушій на VPS.

import { SCORING_BASIS_SQL } from "@/lib/consent";

/** Не частіше одного завдання на людину за стільки секунд. */
export const ENQUEUE_SPACING_SECONDS = 60;

export type EnqueueResult =
  | { ok: true; jobId: number }
  /** Завдання вже чекає: рушій прочитає свіжі джерела, коли дійде до нього. */
  | { ok: false; reason: "already_queued" }
  | { ok: false; reason: "too_soon"; retryAfterSeconds: number }
  /** Без згоди на бал не рахуємо нічого. */
  | { ok: false; reason: "no_consent" };

/**
 * Одна інструкція вирішує й пише: два паралельні натискання не дадуть двох
 * завдань (D1 виконує інструкції послідовно).
 *
 * Про читання: індексу score_jobs(user_id) немає. «Чи чекає» йде індексом
 * (status, queued_at) по рядках 'queued'; «коли було останнє» бере рядки з
 * кінця за id і зупиняється на першому рядку людини.
 */
export async function enqueueScoreJob(
  db: D1Database,
  userId: string,
  reason: "connect" | "manual",
): Promise<EnqueueResult> {
  const spacing = `-${ENQUEUE_SPACING_SECONDS} seconds`;
  const inserted = await db
    .prepare(
      `INSERT INTO score_jobs (user_id, reason)
       SELECT ?1, ?2
        WHERE EXISTS (SELECT 1 FROM consents WHERE user_id = ?1 AND kind IN ${SCORING_BASIS_SQL} AND granted = 1)
          AND NOT EXISTS (SELECT 1 FROM score_jobs WHERE status = 'queued' AND user_id = ?1)
          AND COALESCE((SELECT queued_at FROM score_jobs WHERE user_id = ?1 ORDER BY id DESC LIMIT 1), '')
              <= datetime('now', ?3)
       RETURNING id`,
    )
    .bind(userId, reason, spacing)
    .first<{ id: number }>();
  if (inserted) return { ok: true, jobId: inserted.id };

  const why = await db
    .prepare(
      `SELECT
         EXISTS (SELECT 1 FROM consents WHERE user_id = ?1 AND kind IN ${SCORING_BASIS_SQL} AND granted = 1) AS consent,
         EXISTS (SELECT 1 FROM score_jobs WHERE status = 'queued' AND user_id = ?1) AS queued,
         (SELECT CAST(strftime('%s', queued_at) AS INTEGER) FROM score_jobs WHERE user_id = ?1
           ORDER BY id DESC LIMIT 1) + ?2 - CAST(strftime('%s', 'now') AS INTEGER) AS wait`,
    )
    .bind(userId, ENQUEUE_SPACING_SECONDS)
    .first<{ consent: number; queued: number; wait: number | null }>();
  if (!why?.consent) return { ok: false, reason: "no_consent" };
  if (why.queued) return { ok: false, reason: "already_queued" };
  return { ok: false, reason: "too_soon", retryAfterSeconds: Math.max(1, why.wait ?? 1) };
}
