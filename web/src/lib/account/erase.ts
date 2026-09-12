import { crmErasureBlock, notifyCrmErasure } from "./hooks";

/**
 * «Delete my account» (GDPR ст. 17). Видаляємо рядок users, решту забирає
 * ON DELETE CASCADE (тест erase.test.ts перевіряє кожну таблицю з user_id).
 * Поза каскадом, тим самим пакетом:
 * - login_codes: прив'язані до пошти, не до id;
 * - auth_attempts: ключі лічильників містять пошту або id людини.
 * audit_log лишається: там лише id без особистих даних (0002_auth), і запис
 * про саме видалення потрібен, щоб довести, що його зроблено.
 */

export type EraseResult = { ok: true } | { ok: false; reason: "no_user" | "blocked"; message?: string };

export async function eraseAccount(d: D1Database, userId: string): Promise<EraseResult> {
  const user = await d.prepare("SELECT email FROM users WHERE id = ?").bind(userId).first<{ email: string | null }>();
  if (!user) return { ok: false, reason: "no_user" };

  const block = await crmErasureBlock(userId);
  if (block) return { ok: false, reason: "blocked", message: block };

  // CRM першою: їй ще потрібні знайомства й картки, які каскад зараз прибере.
  await notifyCrmErasure(userId);

  const email = user.email ?? "";
  const suffix = `:${userId}`;
  await d.batch([
    d.prepare("DELETE FROM login_codes WHERE email = ?").bind(email),
    d
      .prepare(
        `DELETE FROM auth_attempts
          WHERE key IN (?1, ?2, ?3)
             OR (length(key) > length(?4) AND substr(key, -length(?4)) = ?4)`,
      )
      .bind(`code:email:${email}`, `code:email:day:${email}`, `verify:email:${email}`, suffix),
    d
      .prepare("INSERT INTO audit_log (actor, action, target, meta_json) VALUES (?, 'account.delete', ?, NULL)")
      .bind(userId, userId),
    d.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
  return { ok: true };
}
