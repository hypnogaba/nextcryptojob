import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db } from "@/lib/db";
import { WANTED_JOB_COOKIE, takeWantedJob } from "@/lib/jobs/wanted";
import { randomToken, sha256Hex } from "./hash";

/**
 * Сесії входу (як у NextRole, src/lib/auth.ts), з двома відмінностями:
 * - у куці лежить випадковий токен, а в базі лише його SHA-256
 *   (docs/contracts.md, §9): витік бази не дає чужих сесій;
 * - час рахує сам SQL (datetime('now', ...)), у форматі SQLite, а не ISO.
 */

export const SESSION_COOKIE = "ncj_session";
export const SESSION_DAYS = 30;

/** Параметри куки сесії. Токен недоступний JS і не йде на чужі сайти. */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  };
}

// Токен з randomToken(): 43 символи base64url. Інше навіть не шукаємо в базі.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Чим відкрито сесію (sessions.method, 0013). Адмінка пускає лише 'email'. */
export type SessionMethod = "email" | "telegram";

export type SessionUser = {
  id: string;
  email: string | null;
  channel: "email" | "telegram";
  /** null у сесій, відкритих до 0013: вони живуть далі, але адміном не роблять. */
  method: SessionMethod | null;
};

/**
 * Створює сесію для людини й ставить куку. Лише в Server Action або Route Handler.
 * Метод називає виклик явно; null теж підходить, але тоді сесія звичайна, не адмінська.
 */
export async function createSession(userId: string, method: SessionMethod | null): Promise<void> {
  const token = randomToken();
  const id = await sha256Hex(token);
  const d = db();
  await d.batch([
    // Протерміновані сесії цієї людини більше не потрібні.
    d.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at <= datetime('now')").bind(userId),
    d
      .prepare("INSERT INTO sessions (id, user_id, expires_at, method) VALUES (?, ?, datetime('now', ?), ?)")
      .bind(id, userId, `+${SESSION_DAYS} days`, method),
  ]);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, sessionCookieOptions());

  // Раунд 6: вакансія, заради якої людина прийшла з головної (/start?job=…), стає збереженою,
  // тож вона знайде її в кабінеті, вкладка Saved на /jobs.
  const wanted = jar.get(WANTED_JOB_COOKIE)?.value;
  if (wanted) {
    await takeWantedJob(d, userId, wanted);
    jar.delete(WANTED_JOB_COOKIE);
  }
}

/**
 * Людина за кукою сесії або null. Один запит до бази на запит сторінки
 * (cache), і лише коли кука є.
 */
export const currentUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || !TOKEN_SHAPE.test(token)) return null;

  const d = db();
  const row = await d
    .prepare(
      `SELECT u.id, u.email, u.channel, s.method,
              u.last_active_at < datetime('now', '-1 hour') AS stale
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.expires_at > datetime('now')`,
    )
    .bind(await sha256Hex(token))
    .first<{
      id: string;
      email: string | null;
      channel: SessionUser["channel"];
      method: string | null;
      stale: number;
    }>();
  if (!row) return null;

  // last_active_at пишемо не частіше разу на годину: запис на кожен запит
  // коштував би більше, ніж дає точність до хвилини.
  if (row.stale) {
    await d
      .prepare(
        "UPDATE users SET last_active_at = datetime('now') WHERE id = ? AND last_active_at < datetime('now', '-1 hour')",
      )
      .bind(row.id)
      .run();
  }
  const method = row.method === "email" || row.method === "telegram" ? row.method : null;
  return { id: row.id, email: row.email, channel: row.channel, method };
});

/** Людина або перехід на /login. Для сторінок і дій, де без входу нічого робити. */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

/** Закриває поточну сесію: рядок у базі й куку. */
export async function signOut(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token && TOKEN_SHAPE.test(token)) {
    await db().prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256Hex(token)).run();
  }
  jar.delete(SESSION_COOKIE);
}
