import type { NotifyEnv } from "@/lib/crm/notify";
import { deliverWebhooks } from "@/lib/crm/webhooks";
import { savedSearchAlerts } from "./alerts";
import { countStalePayments, dailyCleanup } from "./cleanup";
import { expireIntros } from "./intros";

/**
 * Планувальник (специфікація CRM 3.6). Точка входу Worker (web/worker.ts) на
 * кожен тригер з wrangler.jsonc кличе runCron(controller.cron, env, …).
 *
 * | Тригер          | Задачі                                                            |
 * |-----------------|-------------------------------------------------------------------|
 * | кожні 5 хв      | прострочення знайомств і мертві броні, потім доставка вебхуків    |
 * | щогодини        | сповіщення збережених пошуків, завислі платежі x402 (лише підрахунок) |
 * | щодня 03:00 UTC | прибирання: сесії, коди входу, лічильники, апдейти бота, облік 400 днів |
 *
 * Кожна задача обмежена пачкою й добирає решту наступним запуском, повтор
 * безпечний (умовні UPDATE, умови прибирання). Задачі йдуть по черзі, кожна у
 * своєму try: збій однієї не зупиняє інших. Кожна пише рядок JSON з лічильниками
 * в журнал Worker (observability увімкнено у wrangler.jsonc).
 */

export const CRONS = {
  every5Minutes: "*/5 * * * *",
  hourly: "0 * * * *",
  daily: "0 3 * * *",
} as const;

/** Прив'язки й секрети, які читають задачі. */
export type CronEnv = NotifyEnv & {
  DB: D1Database;
  WEBHOOK_SIGNING_KEY?: string;
};

export interface CronTime {
  /** Справжня мить запуску: від неї рахуються терміни й підпис вебхука. */
  now: Date;
  /** Запланована мить тригера (рівно на межі хвилини): від неї розклад сповіщень. */
  scheduled: Date;
}

export type Counts = Record<string, number>;

export interface CronJob {
  name: string;
  run: (env: CronEnv, time: CronTime) => Promise<Counts>;
}

export const JOBS = {
  expireIntros: {
    name: "intros.expire",
    run: async (env, { now }) => ({ ...(await expireIntros(env.DB, { env, now })) }),
  },
  deliverWebhooks: {
    name: "webhooks.deliver",
    run: async (env, { now }) => ({ ...(await deliverWebhooks(env.DB, { env, now })) }),
  },
  savedSearchAlerts: {
    name: "saved_searches.alert",
    run: async (env, { scheduled }) => ({ ...(await savedSearchAlerts(env.DB, { env, now: scheduled })) }),
  },
  stalePayments: {
    name: "x402.stale",
    run: async (env, { now }) => {
      const counts = await countStalePayments(env.DB, now);
      if (counts.stalePayments > 0) console.warn(`cron: ${counts.stalePayments} x402 payments need a manual check (/admin/payments)`);
      return counts;
    },
  },
  dailyCleanup: {
    name: "cleanup.daily",
    run: async (env, { now }) => dailyCleanup(env.DB, { now }),
  },
} satisfies Record<string, CronJob>;

export const SCHEDULE: Record<string, readonly CronJob[]> = {
  [CRONS.every5Minutes]: [JOBS.expireIntros, JOBS.deliverWebhooks],
  [CRONS.hourly]: [JOBS.savedSearchAlerts, JOBS.stalePayments],
  [CRONS.daily]: [JOBS.dailyCleanup],
};

export interface JobReport {
  job: string;
  ok: boolean;
  ms: number;
  counts?: Counts;
  error?: string;
}

export interface CronReport {
  cron: string;
  jobs: JobReport[];
}

export interface RunCronOptions {
  /** controller.scheduledTime (мс); без нього = зараз. */
  scheduledTime?: number;
  now?: () => Date;
  /** Інший розклад (тести). */
  schedule?: Record<string, readonly CronJob[]>;
}

export async function runCron(cron: string, env: CronEnv, opts: RunCronOptions = {}): Promise<CronReport> {
  const clock = opts.now ?? (() => new Date());
  const jobs = (opts.schedule ?? SCHEDULE)[cron];
  const report: CronReport = { cron, jobs: [] };
  if (!jobs) {
    console.warn(`cron: no jobs for "${cron}"`);
    return report;
  }
  const scheduled = new Date(opts.scheduledTime ?? clock().getTime());
  for (const job of jobs) {
    const started = Date.now();
    try {
      const counts = await job.run(env, { now: clock(), scheduled });
      const entry: JobReport = { job: job.name, ok: true, ms: Date.now() - started, counts };
      report.jobs.push(entry);
      console.log(JSON.stringify({ cron, ...entry }));
    } catch (error) {
      const entry: JobReport = {
        job: job.name,
        ok: false,
        ms: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      };
      report.jobs.push(entry);
      console.error(JSON.stringify({ cron, ...entry }));
    }
  }
  return report;
}
