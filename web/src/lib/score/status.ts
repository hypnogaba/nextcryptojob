// Стан балу людини для сторінки профілю й опитування з браузера: останнє
// завдання черги й чи є вже бал. Лише про саму людину.

export type JobState = "queued" | "running" | "done" | "failed";

export type ProfileStatus = {
  job: {
    status: JobState;
    /** Скільки секунд минуло від постановки в чергу. */
    waitedSeconds: number;
  } | null;
  /** Чи є в людини хоч один рядок scores. */
  scored: boolean;
};

export async function profileStatus(db: D1Database, userId: string): Promise<ProfileStatus> {
  const [job, scored] = await db.batch([
    // Від кінця за id до першого рядка людини (індексу user_id на score_jobs немає).
    db
      .prepare(
        `SELECT status, CAST(strftime('%s', 'now') AS INTEGER) - CAST(strftime('%s', queued_at) AS INTEGER) AS waited
           FROM score_jobs WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .bind(userId),
    db.prepare("SELECT EXISTS (SELECT 1 FROM scores WHERE user_id = ?) AS scored").bind(userId),
  ]);
  const jobRow = (job.results as { status: JobState; waited: number }[])[0];
  const scoredRow = (scored.results as { scored: number }[])[0];
  return {
    job: jobRow ? { status: jobRow.status, waitedSeconds: Math.max(0, jobRow.waited ?? 0) } : null,
    scored: scoredRow?.scored === 1,
  };
}

/** Чи варто браузеру питати ще: завдання чекає або рахується. */
export function isActive(status: ProfileStatus): boolean {
  return status.job?.status === "queued" || status.job?.status === "running";
}
