import { db } from "@/lib/db";
import { candidateErasurePlan, erasureBlockReason, onVisibilityChanged } from "@/lib/crm/visibility";

/**
 * Точки, де налаштування й видалення акаунта кажуть CRM про зміну
 * (специфікація CRM, розділи 11 і 13). Реалізація в web/src/lib/crm/visibility.ts.
 */

/**
 * Після зміни видимості (уже записаної в базу): CRM пише visibility_lost або
 * visibility_restored у картки воронки цієї людини за живим правилом видимості
 * для кожної компанії. Зміну налаштування вже збережено, тож збій CRM тут лише
 * в журнал сервера: людина не має бачити "Something went wrong" за те, що
 * вдалося (історію карток зведе наступна зміна видимості).
 */
export async function notifyCrmVisibility(userId: string, visible: boolean): Promise<void> {
  try {
    await onVisibilityChanged(userId, visible);
  } catch (err) {
    console.error(`crm: visibility events not written: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface CrmErasure {
  /** Записи CRM для того самого пакета, що й DELETE FROM users (перед ним). */
  statements: D1PreparedStatement[];
  /** Листи компаніям з відкритим контактом (GDPR ст. 19). Лише після коміту пакета; сам не кидає. */
  afterCommit: () => Promise<void>;
}

/**
 * Перед видаленням рядка users: CRM читає, кому людина відкрила контакт (поки
 * каскад ще не прибрав знайомства), і дає записи для пакета видалення: людина
 * зникає для компаній, candidate.erased у журнал кожної компанії з карткою чи
 * знайомством, відкриті знайомства скасовано. Виняток тут зупиняє видалення:
 * краще не видалити, ніж видалити мовчки.
 */
export async function notifyCrmErasure(userId: string, d: D1Database = db()): Promise<CrmErasure> {
  const plan = await candidateErasurePlan(userId, { db: d });
  return {
    statements: plan.statements,
    afterCommit: async () => {
      try {
        const sent = await plan.notify();
        if (sent.mailFailed || sent.ownersWithoutEmail) {
          console.error(
            `crm: erasure notices: ${sent.mailed} sent, ${sent.mailFailed} failed, ${sent.ownersWithoutEmail} owners without email`,
          );
        }
      } catch (err) {
        console.error(`crm: erasure notices failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

/**
 * Причина, чому акаунт зараз видаляти не можна, або null: людина єдиний
 * власник компанії, що працює або чекає перевірки (специфікація CRM 6.3, 13).
 * Текст: "Make someone else an owner or close the company first."
 */
export async function crmErasureBlock(userId: string, d: D1Database = db()): Promise<string | null> {
  return erasureBlockReason(userId, d);
}
