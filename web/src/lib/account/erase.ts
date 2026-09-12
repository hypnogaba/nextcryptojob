import { crmErasureBlock, notifyCrmErasure } from "./hooks";

/**
 * «Delete my account» (GDPR ст. 17). Видаляємо рядок users, решту забирає
 * ON DELETE CASCADE (тест erase.test.ts перевіряє кожну таблицю з user_id).
 * Поза каскадом, тим самим пакетом:
 * - записи CRM (людина зникає для компаній, candidate.erased у журнал компаній,
 *   відкриті знайомства скасовано); листи компаніям лише після коміту;
 * - login_codes: прив'язані до пошти, не до id;
 * - auth_attempts: ключі лічильників містять пошту, id людини або її Telegram
 *   (`tg-chat:<telegram_id>`, лічильник бота).
 * audit_log лишається: там лише id без особистих даних (0002_auth), і запис
 * про саме видалення потрібен, щоб довести, що його зроблено.
 */

export type EraseResult = { ok: true } | { ok: false; reason: "no_user" | "blocked"; message?: string };

export async function eraseAccount(d: D1Database, userId: string): Promise<EraseResult> {
  const user = await d
    .prepare("SELECT email, telegram_id FROM users WHERE id = ?")
    .bind(userId)
    .first<{ email: string | null; telegram_id: string | null }>();
  if (!user) return { ok: false, reason: "no_user" };

  const block = await crmErasureBlock(userId, d);
  if (block) return { ok: false, reason: "blocked", message: block };

  // CRM першою: їй ще потрібні знайомства й картки, які каскад зараз прибере.
  const crm = await notifyCrmErasure(userId, d);

  const email = user.email ?? "";
  const suffix = `:${userId}`;
  await d.batch([
    ...crm.statements,
    d.prepare("DELETE FROM login_codes WHERE email = ?").bind(email),
    d
      .prepare(
        `DELETE FROM auth_attempts
          WHERE key IN (?1, ?2, ?3)
             OR (length(key) > length(?4) AND substr(key, -length(?4)) = ?4)`,
      )
      .bind(`code:email:${email}`, `code:email:day:${email}`, `verify:email:${email}`, suffix),
    ...(user.telegram_id ? [d.prepare("DELETE FROM auth_attempts WHERE key = ?").bind(`tg-chat:${user.telegram_id}`)] : []),
    d
      .prepare("INSERT INTO audit_log (actor, action, target, meta_json) VALUES (?, 'account.delete', ?, NULL)")
      .bind(userId, userId),
    d.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
  await crm.afterCommit();
  return { ok: true };
}
