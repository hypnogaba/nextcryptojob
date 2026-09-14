import { appEnv } from "@/lib/db";
import { isAdminEmail } from "./admin-list";
import { currentUser, type SessionUser } from "./session";

/**
 * Хто адмін, поки немає ролей адміна з 0007 (доріжка адмінки).
 *
 * Змінна Worker `ADMIN_EMAILS`: пошти через кому, без розрізнення регістру.
 * Не задано або порожньо → лише власник продукту. Пошта в users.email
 * з'являється тільки після перевірки коду з листа (lib/auth/email-code.ts), тож
 * вона підтверджена.
 *
 * Крім пошти зі списку, сама сесія мусить бути відкрита входом поштою
 * (sessions.method = 'email'). Адмін, що має й Telegram, увійшовши через
 * Telegram, адміном у цій сесії не буде: доступ до адмінки тримається лише на
 * скриньці, а не на акаунті Telegram, прив'язаному до того ж профілю.
 */

// Список адмінів без залежностей (його читає й cron у точці входу Worker): ./admin-list.ts.
export { adminEmails, DEFAULT_ADMIN_EMAILS, isAdminEmail } from "./admin-list";

/** Адмін: пошта зі списку і сесія, відкрита кодом з листа. */
export function isAdminSession(user: SessionUser, raw: string | undefined): boolean {
  return user.method === "email" && isAdminEmail(user.email, raw);
}

/** Людина з сесії, якщо вона адмін; інакше null. Кожна сторінка й дія адмінки перевіряє це сама. */
export async function currentAdmin(): Promise<SessionUser | null> {
  const user = await currentUser();
  if (!user) return null;
  const raw = (appEnv() as { ADMIN_EMAILS?: string }).ADMIN_EMAILS;
  return isAdminSession(user, raw) ? user : null;
}
