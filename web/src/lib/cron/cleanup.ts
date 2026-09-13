import { sqlTime } from "@/lib/time";
import { CRON_RUNS_KEEP_DAYS } from "./runs";

/**
 * Щоденне прибирання (cron о 03:00 UTC). Решта коду прибирає ліниво (вхід
 * стирає старі коди й лічильники, нова сесія стирає прострочені сесії тієї самої
 * людини, вебхук бота зрідка чистить свої update_id); тут те, що ліниво ніколи
 * не зникне: сесії людей, що більше не входили, коди без нового входу, старий
 * облік використання (специфікація 3.6: purgeUsage, 400 днів), журнал запусків cron (30 днів).
 *
 * Кожна таблиця шматками по CHUNK рядків (DELETE … WHERE rowid IN (SELECT … LIMIT)),
 * не більше MAX_CHUNKS шматків за запуск: великий хвіст добере наступна ніч.
 * Повторний запуск нічого не ламає: умова та сама, видаляти вже нічого.
 */

export const CHUNK = 500;
export const MAX_CHUNKS = 20;
const DAY_MS = 86_400_000;

interface Rule {
  table: string;
  where: string;
  params: (now: Date) => (string | number)[];
}

const RULES: Rule[] = [
  // Прострочені сесії.
  { table: "sessions", where: "expires_at <= ?", params: (now) => [sqlTime(now)] },
  // Коди входу: день після кінця терміну (так само, як лінивий DELETE при новому коді).
  { table: "login_codes", where: "expires_at < ?", params: (now) => [sqlTime(new Date(now.getTime() - DAY_MS))] },
  // Лічильники спроб: у ключах пошти й IP, довше доби не тримаємо (pruneRateStatement).
  {
    table: "auth_attempts",
    where: "window_start < ? AND (blocked_until IS NULL OR blocked_until < ?)",
    params: (now) => [sqlTime(new Date(now.getTime() - DAY_MS)), sqlTime(now)],
  },
  // Дедуплікація апдейтів бота: Telegram повторює не довше доби, тримаємо 3.
  { table: "webhook_updates", where: "seen_at < ?", params: (now) => [sqlTime(new Date(now.getTime() - 3 * DAY_MS))] },
  // Облік використання живе 400 днів (0004_billing).
  { table: "usage_events", where: "created_at < ?", params: (now) => [sqlTime(new Date(now.getTime() - 400 * DAY_MS))] },
  // Журнал запусків cron живе CRON_RUNS_KEEP_DAYS (0019). Останнім: таблиця з'являється з 0019,
  // і поки її немає, збій цього правила не заважає решті прибирання.
  {
    table: "cron_runs",
    where: "started_at < ?",
    params: (now) => [sqlTime(new Date(now.getTime() - CRON_RUNS_KEEP_DAYS * DAY_MS))],
  },
];

export type CleanupResult = Record<string, number>;

export async function dailyCleanup(
  db: D1Database,
  opts: { now?: Date; chunk?: number; maxChunks?: number; deadline?: number; clock?: () => Date } = {},
): Promise<CleanupResult> {
  const now = opts.now ?? new Date();
  const clock = opts.clock ?? (() => new Date());
  const late = () => opts.deadline !== undefined && clock().getTime() >= opts.deadline;
  const chunk = opts.chunk ?? CHUNK;
  const maxChunks = opts.maxChunks ?? MAX_CHUNKS;
  const out: CleanupResult = {};
  for (const rule of RULES) {
    let deleted = 0;
    for (let i = 0; i < maxChunks && !late(); i++) {
      const res = await db
        .prepare(`DELETE FROM ${rule.table} WHERE rowid IN (SELECT rowid FROM ${rule.table} WHERE ${rule.where} LIMIT ?)`)
        .bind(...rule.params(now), chunk)
        .run();
      const n = res.meta.changes ?? 0;
      deleted += n;
      if (n < chunk) break;
    }
    out[rule.table] = deleted;
  }
  return out;
}

/**
 * Скільки платежів x402 треба звірити руками (та сама умова, що findStalePayments
 * у lib/x402/server.ts і сторінка /admin/payments): 'verified' старші за 5 хв і
 * всі 'unconfirmed'. Cron лише рахує й пише в журнал Worker; вирішує адмін.
 * Окремий запит, а не імпорт x402/server: точка входу cron не тягне бібліотек x402.
 */
export async function countStalePayments(db: D1Database, now: Date = new Date()): Promise<{ stalePayments: number }> {
  const n = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM x402_payments
        WHERE (status = 'verified' AND created_at < ?) OR status = 'unconfirmed'`,
    )
    .bind(sqlTime(new Date(now.getTime() - 5 * 60_000)))
    .first<number>("n");
  return { stalePayments: n ?? 0 };
}
