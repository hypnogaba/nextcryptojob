import { expireDue, purgeStaleHolds } from "@/lib/crm/intros";
import { notifierFromEnv, type Notifier, type NotifyEnv } from "@/lib/crm/notify";

/**
 * Прострочення знайомств (специфікація CRM, 3.6 і 5.5): кожні 5 хв (планувальник
 * додає T11). Те саме робить і кожне читання знайомства (ліниве прострочення в
 * lib/crm/intros.ts), тож cron лише добирає ті, яких ніхто не читав.
 * Бере до 200 знайомств у pending з expires_at <= зараз (індекс idx_intros_expiry),
 * кожне окремим пакетом: expired, картка → found (якщо досі intro_requested),
 * вебхук intro.expired у чергу, журнал. Потім тому, хто просив:
 * "No answer from #3F9A1C in 14 days.". Решту добере наступний запуск.
 * Відповідь кандидата, що встигла раніше, перемагає: таке знайомство пропускаємо.
 * Заодно звільняє пари з мертвими бронями (процес упав між бронею і записом).
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
  /** Мертвих броней прибрано. */
  holdsPurged: number;
}

export async function expireIntros(db: D1Database, opts: ExpireIntrosOptions = {}): Promise<ExpireIntrosResult> {
  const now = opts.now ?? new Date();
  const notifier = opts.notifier ?? notifierFromEnv(opts.env ?? {});
  const expired = await expireDue(db, {}, now, notifier, opts.limit ?? EXPIRE_BATCH);
  const holdsPurged = await purgeStaleHolds(db, now);
  return { expired, holdsPurged };
}
