import { sqlTime } from "@/lib/time";

/**
 * Журнал запусків cron (таблиця cron_runs, 0019): рядок на задачу на запуск. Пише runCron
 * (./index.ts) одразу після кожної задачі; читає головна адмінки (lib/admin/overview.ts);
 * прибирає щоденне прибирання (./cleanup.ts) через CRON_RUNS_KEEP_DAYS.
 *
 * Запис не має зламати запуск: таблиці ще немає (0019 не накочено) або база не відповіла,
 * тоді лише рядок у журналі Worker. Лічильники задач це числа, персональних даних у них немає.
 */

export const CRON_RUNS_KEEP_DAYS = 30;
/** Довший текст помилки не потрібен адмінці, а рядок живе місяць. */
export const MAX_ERROR_LENGTH = 500;

export interface CronRunEntry {
  job: string;
  ok: boolean;
  ms: number;
  counts?: Record<string, number>;
  error?: string;
}

export async function recordCronRun(db: D1Database, cron: string, startedAt: Date, entry: CronRunEntry): Promise<void> {
  try {
    await db
      .prepare("INSERT INTO cron_runs (job, cron, started_at, ms, ok, counts_json, error) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(
        entry.job,
        cron,
        sqlTime(startedAt),
        Math.max(0, Math.round(entry.ms)),
        entry.ok ? 1 : 0,
        entry.counts ? JSON.stringify(entry.counts) : null,
        entry.error ? entry.error.slice(0, MAX_ERROR_LENGTH) : null,
      )
      .run();
  } catch (error) {
    console.error(
      JSON.stringify({ cron, job: entry.job, error: `cron_runs not written: ${error instanceof Error ? error.message : String(error)}` }),
    );
  }
}
