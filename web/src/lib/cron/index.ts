import { runOwnerAlerts } from "@/lib/admin/alerts";
import { runWeeklyReport } from "@/lib/admin/weekly";
import { notifierFromEnv, type NotifyEnv } from "@/lib/crm/notify";
import { jobsDbFromEnv } from "@/lib/jobs-db";
import { DELIVER_BUDGET_MS, deliverWebhooks } from "@/lib/crm/webhooks";
import { savedSearchAlerts } from "./alerts";
import { countStalePayments, dailyCleanup } from "./cleanup";
import { expireIntros } from "./intros";
import { closeExpiredJobs } from "./jobs";
import { recordCronRun } from "./runs";

/**
 * Планувальник (специфікація CRM 3.6). Точка входу Worker (web/worker.ts) на
 * кожен тригер з wrangler.jsonc кличе runCron(controller.cron, env, …).
 *
 * | Тригер          | Задачі                                                            |
 * |-----------------|-------------------------------------------------------------------|
 * | кожні 5 хв      | прострочення знайомств і мертві броні, потім доставка вебхуків    |
 * | щогодини        | прострочені вакансії компаній, сповіщення збережених пошуків, завислі платежі x402 (лише підрахунок), сповіщення власнику, щотижневий звіт (понеділок 08:00 UTC) |
 * | щодня 03:00 UTC | прибирання: сесії, коди входу, лічильники, апдейти бота, облік 400 днів, журнал cron 30 днів |
 *
 * Кожна задача обмежена пачкою і часом (CRON_BUDGET_MS, budgetMs) і добирає
 * решту наступним запуском, повтор безпечний (умовні UPDATE, умови прибирання).
 * Задачі йдуть по черзі, кожна у своєму try: збій однієї не зупиняє інших. Кожна пише рядок JSON з лічильниками
 * в журнал Worker (observability увімкнено у wrangler.jsonc) і рядок у cron_runs (0019, lib/cron/runs.ts):
 * з нього головна адмінки бачить останній запуск кожної задачі.
 */

export const CRONS = {
  every5Minutes: "*/5 * * * *",
  hourly: "0 * * * *",
  daily: "0 3 * * *",
} as const;

/**
 * Скільки мс може тривати весь запуск тригера. Кожен запуск закінчується до
 * наступного того самого тригера: 5-хвилинний за 4,5 хв, щогодинний і щоденний
 * за 10 хв (межа Cloudflare для scheduled 15 хв). Задача, яка не встигла, добере
 * решту наступним запуском; задача, до якої черга не дійшла, чекає наступного.
 */
export const CRON_BUDGET_MS: Record<string, number> = {
  [CRONS.every5Minutes]: 270_000,
  [CRONS.hourly]: 600_000,
  [CRONS.daily]: 600_000,
};
const DEFAULT_BUDGET_MS = 60_000;

/** Прив'язки й секрети, які читають задачі. */
export type CronEnv = NotifyEnv & {
  DB: D1Database;
  WEBHOOK_SIGNING_KEY?: string;
  /** База вакансій (лише читання, lib/jobs-db.ts): сповіщення власнику про сканер. */
  JOBS_DB?: D1Database;
  /** Кому сповіщення власнику й щотижневий звіт (lib/auth/admin.ts). */
  ADMIN_EMAILS?: string;
};

export interface CronTime {
  /** Справжня мить старту задачі. */
  now: Date;
  /** Запланована мить тригера (рівно на межі хвилини): від неї розклад сповіщень. */
  scheduled: Date;
  /** Годинник для міток, що мусять бути свіжими (оренда й підпис вебхука). */
  clock: () => Date;
  /** Після цієї миті (мс) задача не бере нової роботи. */
  deadline: number;
}

export type Counts = Record<string, number>;

export interface CronJob {
  name: string;
  /** Власна межа задачі від її старту (у межах межі тригера). */
  budgetMs?: number;
  run: (env: CronEnv, time: CronTime) => Promise<Counts>;
}

export const JOBS = {
  expireIntros: {
    name: "intros.expire",
    // Решта 5-хвилинного запуску лишається вебхукам.
    budgetMs: 60_000,
    run: async (env, { now, clock, deadline }) => ({ ...(await expireIntros(env.DB, { env, now, clock, deadline })) }),
  },
  deliverWebhooks: {
    name: "webhooks.deliver",
    budgetMs: DELIVER_BUDGET_MS,
    run: async (env, { clock, deadline }) => ({ ...(await deliverWebhooks(env.DB, { env, clock, deadline })) }),
  },
  closeExpiredJobs: {
    name: "jobs.expire",
    // Дешево й рідко: решта щогодинного запуску лишається сповіщенням.
    budgetMs: 60_000,
    run: async (env, { now, clock, deadline }) => ({ ...(await closeExpiredJobs(env.DB, { env, now, clock, deadline })) }),
  },
  savedSearchAlerts: {
    name: "saved_searches.alert",
    run: async (env, { scheduled, clock, deadline }) => ({ ...(await savedSearchAlerts(env.DB, { env, now: scheduled, clock, deadline })) }),
  },
  stalePayments: {
    name: "x402.stale",
    run: async (env, { now }) => {
      const counts = await countStalePayments(env.DB, now);
      if (counts.stalePayments > 0) console.warn(`cron: ${counts.stalePayments} x402 payments need a manual check (/admin/payments)`);
      return counts;
    },
  },
  ownerAlerts: {
    name: "owner.alerts",
    budgetMs: 120_000,
    run: async (env, { now }) => {
      // Розклад читаємо тут, а не при завантаженні модуля: SCHEDULE оголошено нижче.
      const cronJobs = Object.entries(SCHEDULE).flatMap(([cron, jobs]) => jobs.map((j) => ({ job: j.name, cron })));
      return {
        ...(await runOwnerAlerts(env.DB, {
          jobs: jobsDbFromEnv(env),
          cronJobs,
          notifier: notifierFromEnv(env),
          adminEmails: env.ADMIN_EMAILS,
          now,
        })),
      };
    },
  },
  weeklyReport: {
    name: "owner.weekly",
    budgetMs: 60_000,
    run: async (env, { scheduled }) => {
      const res = await runWeeklyReport(env.DB, {
        jobs: jobsDbFromEnv(env),
        notifier: notifierFromEnv(env),
        adminEmails: env.ADMIN_EMAILS,
        now: scheduled,
      });
      return { sent: res.sent ? 1 : 0, channels: res.channels.length, errors: res.errors.length };
    },
  },
  dailyCleanup: {
    name: "cleanup.daily",
    run: async (env, { now, clock, deadline }) => dailyCleanup(env.DB, { now, clock, deadline }),
  },
} satisfies Record<string, CronJob>;

export const SCHEDULE: Record<string, readonly CronJob[]> = {
  [CRONS.every5Minutes]: [JOBS.expireIntros, JOBS.deliverWebhooks],
  [CRONS.hourly]: [JOBS.closeExpiredJobs, JOBS.savedSearchAlerts, JOBS.stalePayments, JOBS.ownerAlerts, JOBS.weeklyReport],
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
  /** Інша межа тригера (тести). */
  budgetMs?: number;
}

export async function runCron(cron: string, env: CronEnv, opts: RunCronOptions = {}): Promise<CronReport> {
  const clock = opts.now ?? (() => new Date());
  const jobs = (opts.schedule ?? SCHEDULE)[cron];
  const report: CronReport = { cron, jobs: [] };
  if (!jobs) {
    console.warn(`cron: no jobs for "${cron}"`);
    return report;
  }
  const start = clock();
  const scheduled = new Date(opts.scheduledTime ?? start.getTime());
  const cronDeadline = start.getTime() + (opts.budgetMs ?? CRON_BUDGET_MS[cron] ?? DEFAULT_BUDGET_MS);
  for (const job of jobs) {
    const jobStart = clock();
    const started = Date.now();
    let entry: JobReport;
    if (jobStart.getTime() >= cronDeadline) {
      entry = { job: job.name, ok: false, ms: 0, error: "skipped: the time budget of this run is used up" };
    } else {
      const deadline = Math.min(cronDeadline, job.budgetMs ? jobStart.getTime() + job.budgetMs : cronDeadline);
      try {
        const counts = await job.run(env, { now: jobStart, scheduled, clock, deadline });
        entry = { job: job.name, ok: true, ms: Date.now() - started, counts };
      } catch (error) {
        entry = { job: job.name, ok: false, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
      }
    }
    report.jobs.push(entry);
    if (entry.ok) console.log(JSON.stringify({ cron, ...entry }));
    else console.error(JSON.stringify({ cron, ...entry }));
    // Одразу після задачі, а не пакетом наприкінці: запуск, який обірвався посередині,
    // лишає рядки задач, що встигли, а решта видно в адмінці як запізнілі.
    await recordCronRun(env.DB, cron, jobStart, entry);
  }
  return report;
}

/**
 * Обробник `scheduled` точки входу Worker. Чекає runCron сам (await), а не через
 * ctx.waitUntil: робота в waitUntil обривається приблизно за 30 с після виходу з
 * обробника, а запуск усе одно звітує «ok». Не кидає: збій задачі вже в звіті,
 * а неочікуваний збій планувальника лише пишеться в журнал.
 */
export function scheduledHandler(opts: Omit<RunCronOptions, "scheduledTime"> = {}) {
  return async (controller: { cron: string; scheduledTime: number }, env: CronEnv): Promise<CronReport | null> => {
    try {
      return await runCron(controller.cron, env, { ...opts, scheduledTime: controller.scheduledTime });
    } catch (error) {
      console.error(JSON.stringify({ cron: controller.cron, error: error instanceof Error ? error.message : String(error) }));
      return null;
    }
  };
}
