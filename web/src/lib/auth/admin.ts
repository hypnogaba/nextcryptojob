import { appEnv } from "@/lib/db";
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

export const DEFAULT_ADMIN_EMAILS: readonly string[] = ["hypnogaba@gmail.com"];

export function adminEmails(raw: string | undefined): string[] {
  const list = (raw ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes("@"));
  return list.length > 0 ? list : [...DEFAULT_ADMIN_EMAILS];
}

export function isAdminEmail(email: string | null | undefined, raw: string | undefined): boolean {
  if (!email) return false;
  return adminEmails(raw).includes(email.trim().toLowerCase());
}

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
