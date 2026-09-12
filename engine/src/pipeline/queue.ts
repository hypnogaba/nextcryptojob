// Черга score_jobs (docs/contracts.md §5). Увесь час рахує SQL (`datetime('now')`, §9).
import type { Db } from "./db.js";
import { shortError } from "./errors.js";

export type JobReason = "connect" | "refresh" | "manual";

/**
 * Узяте завдання. `attempts` уже з цією спробою; це й жетон огорожі: complete, fail і requeue
 * змінюють рядок лише за тим самим attempts, тож запізнілий worker (його завдання вже
 * підібрав sweepStuck і взяв інший) нічого не зіпсує.
 */
export type ClaimedJob = { id: number; userId: string; reason: JobReason; attempts: number };

export interface QueueOptions {
  /** Спроб до `failed` (договір: 3). */
  maxAttempts?: number;
  /** `running` довше за стільки хвилин вважається завислим. */
  stuckAfterMinutes?: number;
  /** Пауза перед повтором невдалого завдання, с (від початку попередньої спроби). */
  retryAfterSeconds?: number;
  /** Скільки кандидатів дивитись за одне claimNext, якщо перших забрали інші. */
  claimCandidates?: number;
}

/** Людей, чиї факти старші за тиждень, ставимо на оновлення не більше стількох на годину. */
export const REFRESH_SPREAD_HOURS = 7 * 24;

type Row = { id: number; user_id: string; reason: JobReason; attempts: number };

export class JobQueue {
  readonly maxAttempts: number;
  readonly stuckAfterMinutes: number;
  readonly retryAfterSeconds: number;
  private readonly claimCandidates: number;

  constructor(private readonly db: Db, o: QueueOptions = {}) {
    this.maxAttempts = o.maxAttempts ?? 3;
    this.stuckAfterMinutes = o.stuckAfterMinutes ?? 10;
    this.retryAfterSeconds = o.retryAfterSeconds ?? 60;
    this.claimCandidates = o.claimCandidates ?? 5;
  }

  /**
   * Найстаріше `queued` завдання, або null. Взяття за договором:
   * `UPDATE ... WHERE id = ? AND status = 'queued'` і перевірка changes = 1. Не повторюється
   * автоматично (attempts + 1 не ідемпотентний): якщо відповідь D1 загубилась після запису,
   * завдання лишиться `running` без виконавця, і його поверне sweepStuck.
   *
   * Пропускаємо людей, у яких уже є `running`: два одночасні збори однієї людини
   * писали б наввипередки, і старіший міг би перезаписати новіший.
   */
  async claimNext(): Promise<ClaimedJob | null> {
    const candidates = await this.db.query<Row>(
      "SELECT id, user_id, reason, attempts FROM score_jobs q " +
      "WHERE status = 'queued' AND (started_at IS NULL OR started_at <= datetime('now', ?)) " +
      "AND NOT EXISTS (SELECT 1 FROM score_jobs r WHERE r.user_id = q.user_id AND r.status = 'running') " +
      "ORDER BY queued_at, id LIMIT ?",
      [`-${this.retryAfterSeconds} seconds`, this.claimCandidates]);
    for (const c of candidates) {
      const { changes } = await this.db.run(
        "UPDATE score_jobs SET status = 'running', started_at = datetime('now'), attempts = attempts + 1, finished_at = NULL " +
        "WHERE id = ? AND status = 'queued' AND attempts = ? " +
        "AND NOT EXISTS (SELECT 1 FROM score_jobs r WHERE r.user_id = score_jobs.user_id AND r.status = 'running')",
        [c.id, c.attempts]);
      if (changes === 1) return { id: c.id, userId: c.user_id, reason: c.reason, attempts: c.attempts + 1 };
    }
    return null;
  }

  /**
   * Готово. Заразом закриває інші `queued` цієї людини, поставлені до початку цієї спроби:
   * ідентичності ми прочитали пізніше, тож їхні зміни вже враховано.
   */
  async complete(job: ClaimedJob): Promise<boolean> {
    const { changes } = await this.db.run(
      "UPDATE score_jobs SET status = 'done', finished_at = datetime('now'), error = NULL " +
      "WHERE id = ? AND status = 'running' AND attempts = ?", [job.id, job.attempts], { idempotent: true });
    if (changes === 1) {
      await this.db.run(
        "UPDATE score_jobs SET status = 'done', finished_at = datetime('now') " +
        "WHERE user_id = ? AND status = 'queued' AND id <> ? " +
        "AND queued_at < (SELECT started_at FROM score_jobs WHERE id = ?)",
        [job.userId, job.id, job.id], { idempotent: true });
    }
    return changes === 1;
  }

  /** Невдача: знову `queued`, поки attempts < maxAttempts, інакше `failed`. Текст помилки короткий і без ключів. */
  async fail(job: ClaimedJob, error: unknown): Promise<"queued" | "failed" | "stale"> {
    const text = shortError(error);
    const { changes } = await this.db.run(
      "UPDATE score_jobs SET status = CASE WHEN attempts < ? THEN 'queued' ELSE 'failed' END, error = ?, " +
      "finished_at = CASE WHEN attempts < ? THEN NULL ELSE datetime('now') END " +
      "WHERE id = ? AND status = 'running' AND attempts = ?",
      [this.maxAttempts, text, this.maxAttempts, job.id, job.attempts], { idempotent: true });
    if (changes !== 1) return "stale";
    return job.attempts < this.maxAttempts ? "queued" : "failed";
  }

  /** Зупинка процесу перервала завдання: повернути в чергу, спробу не рахувати. */
  async requeue(job: ClaimedJob): Promise<boolean> {
    const { changes } = await this.db.run(
      "UPDATE score_jobs SET status = 'queued', attempts = attempts - 1, started_at = NULL " +
      "WHERE id = ? AND status = 'running' AND attempts = ?", [job.id, job.attempts], { idempotent: true });
    return changes === 1;
  }

  /** `running` старші за stuckAfterMinutes: знову `queued`, якщо спроби лишились, інакше `failed`. */
  async sweepStuck(): Promise<number> {
    const { changes } = await this.db.run(
      "UPDATE score_jobs SET status = CASE WHEN attempts < ? THEN 'queued' ELSE 'failed' END, " +
      "error = ?, finished_at = CASE WHEN attempts < ? THEN NULL ELSE datetime('now') END " +
      "WHERE status = 'running' AND started_at < datetime('now', ?)",
      [this.maxAttempts, `stuck: no result in ${this.stuckAfterMinutes} min`, this.maxAttempts,
        `-${this.stuckAfterMinutes} minutes`], { idempotent: true });
    return changes;
  }

  /**
   * Щотижневе оновлення (§5): люди, чий найстаріший `source_facts.fetched_at` старший за 7 днів
   * і в кого немає `queued` чи `running`, найдавніші першими. Не більше `perHour` за годину, рахуючи
   * вже поставлені за останню годину `refresh` (подвійний запуск таймера не подвоює). Типово
   * perHour = ceil(люди з фактами / 168): кожен раз на тиждень, рівномірно по годинах.
   */
  async enqueueRefresh(o: { perHour?: number } = {}): Promise<{ enqueued: number; budget: number }> {
    let perHour = o.perHour;
    if (perHour === undefined) {
      const [row] = await this.db.query<{ n: number }>("SELECT COUNT(DISTINCT user_id) AS n FROM source_facts");
      perHour = Math.max(1, Math.ceil((row?.n ?? 0) / REFRESH_SPREAD_HOURS));
    }
    const [recent] = await this.db.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM score_jobs WHERE reason = 'refresh' AND queued_at > datetime('now', '-1 hour')");
    const budget = Math.max(0, perHour - (recent?.n ?? 0));
    if (budget === 0) return { enqueued: 0, budget };
    // Одна інструкція: вибір і вставка разом, NOT EXISTS тримає «не більше одного в черзі на людину».
    // Не ідемпотентна: повтор після загубленої відповіді взяв би ще `budget` інших людей понад годинну межу.
    const { changes } = await this.db.run(
      "INSERT INTO score_jobs (user_id, reason) " +
      "SELECT sf.user_id, 'refresh' FROM source_facts sf " +
      "WHERE NOT EXISTS (SELECT 1 FROM score_jobs j WHERE j.user_id = sf.user_id AND j.status IN ('queued', 'running')) " +
      "GROUP BY sf.user_id HAVING MIN(sf.fetched_at) < datetime('now', '-7 days') " +
      "ORDER BY MIN(sf.fetched_at), sf.user_id LIMIT ?",
      [budget]);
    return { enqueued: changes, budget };
  }
}
