import { expireIntro, notifyRequester } from "@/lib/crm/intros";
import { notifierFromEnv, type Notifier, type NotifyEnv } from "@/lib/crm/notify";
import { sqlTime } from "@/lib/time";

/**
 * Прострочення знайомств (специфікація CRM, 3.6 і 5.5): кожні 5 хв.
 * Бере до 200 знайомств у pending з expires_at <= зараз (індекс idx_intros_expiry),
 * кожне окремим пакетом: expired, картка → found (якщо досі intro_requested),
 * вебхук intro.expired у чергу, журнал. Потім тому, хто просив:
 * "No answer from #3F9A1C in 14 days.". Решту добере наступний запуск.
 * Відповідь кандидата, що встигла раніше, перемагає: таке знайомство пропускаємо.
 */

export const EXPIRE_BATCH = 200;

export interface ExpireIntrosOptions {
  /** Оточення Worker для сповіщень (TELEGRAM_BOT_TOKEN, EMAIL, SITE_URL). */
  env?: NotifyEnv;
  /** Готовий відправник (тести); інакше з env. */
  notifier?: Notifier;
  now?: Date;
  limit?: number;
}

export interface ExpireIntrosResult {
  expired: number;
  /** Уже не pending на мить запису (відповідь чи скасування встигли). */
  skipped: number;
  /** Скільки людей компанії отримали повідомлення. */
  notified: number;
}

export async function expireIntros(db: D1Database, opts: ExpireIntrosOptions = {}): Promise<ExpireIntrosResult> {
  const now = opts.now ?? new Date();
  const { results } = await db
    .prepare("SELECT id FROM intros WHERE status = 'pending' AND expires_at <= ? ORDER BY expires_at LIMIT ?")
    .bind(sqlTime(now), opts.limit ?? EXPIRE_BATCH)
    .all<{ id: string }>();

  const expired: string[] = [];
  let skipped = 0;
  for (const { id } of results) {
    try {
      if (await expireIntro(db, id, now)) expired.push(id);
      else skipped++;
    } catch (error) {
      skipped++;
      console.error("cron: intro not expired", { id, error: error instanceof Error ? error.message : error });
    }
  }

  let notified = 0;
  if (expired.length) {
    const notifier = opts.notifier ?? notifierFromEnv(opts.env ?? {});
    for (const id of expired) notified += await notifyRequester(db, id, "expired", notifier);
  }
  return { expired: expired.length, skipped, notified };
}
