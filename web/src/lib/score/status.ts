// Стан балу людини для сторінки профілю й опитування з браузера: останнє
// завдання черги, чи є вже бал і чи змінились джерела після останнього
// перерахунку. Лише про саму людину.

export type JobState = "queued" | "running" | "done" | "failed";

export type ProfileStatus = {
  job: {
    status: JobState;
    /** Скільки секунд минуло від постановки в чергу. */
    waitedSeconds: number;
  } | null;
  /** Чи є в людини хоч один рядок scores. */
  scored: boolean;
  /**
   * Джерела чи ролі змінились після того, як рушій почав останнє завдання
   * (або завдання ще не було). Поки завдання в черзі, false: рушій прочитає
   * свіжі джерела сам.
   */
  sourcesChanged: boolean;
};

export async function profileStatus(db: D1Database, userId: string): Promise<ProfileStatus> {
  const [job, scored, change] = await db.batch([
    // Індекс score_jobs(user_id, id), міграція 0010.
    db
      .prepare(
        `SELECT status, COALESCE(started_at, queued_at) AS base,
                CAST(strftime('%s', 'now') AS INTEGER) - CAST(strftime('%s', queued_at) AS INTEGER) AS waited
           FROM score_jobs WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .bind(userId),
    db.prepare("SELECT EXISTS (SELECT 1 FROM scores WHERE user_id = ?) AS scored").bind(userId),
    // Індекс audit_log(actor, at).
    db
      .prepare("SELECT MAX(at) AS at FROM audit_log WHERE actor = ? AND action = 'sources.change'")
      .bind(userId),
  ]);
  const jobRow = (job.results as { status: JobState; base: string; waited: number }[])[0];
  const scoredRow = (scored.results as { scored: number }[])[0];
  const changedAt = (change.results as { at: string | null }[])[0]?.at ?? null;
  // Обидві мітки у форматі SQLite (contracts §9), тож рядки порівнюються як час.
  const sourcesChanged =
    changedAt !== null && (!jobRow || (jobRow.status !== "queued" && changedAt > jobRow.base));
  return {
    job: jobRow ? { status: jobRow.status, waitedSeconds: Math.max(0, jobRow.waited ?? 0) } : null,
    scored: scoredRow?.scored === 1,
    sourcesChanged,
  };
}

/** Чи варто браузеру питати ще: завдання чекає або рахується. */
export function isActive(status: ProfileStatus): boolean {
  return status.job?.status === "queued" || status.job?.status === "running";
}
