import { hmacSha256Hex, hmacSha256Verify } from "@/lib/auth/hash";

/**
 * «Still looking?» (аудит 29.09, F3): людині, що 14 днів нічого не натискала й не відкривала, один раз
 * на 30 днів приходить питання з кнопкою «Yes». Без відповіді за 3 дні добірка ставиться на паузу
 * (users.digest_paused = 1), і з паузи виходить налаштуваннями, /start у боті або тією самою кнопкою пізніше.
 *
 * Тут лише відповідь: кнопка в Telegram (`sl:y`, bot.ts) і підписане посилання з листа
 * (/api/digest/still-looking). Розсилка й пауза: run.ts.
 */

export const STILL_LOOKING_PATH = "/api/digest/still-looking";

const message = (userId: string) => `still:${userId}`;

export async function stillLookingUrl(site: string, key: string, userId: string): Promise<string> {
  const url = new URL(STILL_LOOKING_PATH, site);
  url.searchParams.set("u", userId);
  url.searchParams.set("t", await hmacSha256Hex(key, message(userId)));
  return url.toString();
}

/** user_id з адреси, якщо підпис збігся (за сталий час), інакше null. */
export async function verifyStillLooking(key: string, params: URLSearchParams): Promise<string | null> {
  const userId = params.get("u") ?? "";
  const token = params.get("t") ?? "";
  if (userId.length === 0 || userId.length > 64 || !/^[0-9a-f]{64}$/i.test(token)) return null;
  return (await hmacSha256Verify(key, message(userId), token)) ? userId : null;
}

/**
 * «Yes»: людина тут. Закриває останнє питання без відповіді, рахує це активністю і, якщо добірку вже
 * поставила на паузу саме через тишу, знімає її. Пауза, яку людина поставила сама (/stop, відписка),
 * лишається: її зняти може лише вона в налаштуваннях. true, якщо було що відповідати.
 */
export async function answerStillLooking(d: D1Database, userId: string): Promise<boolean> {
  const open = await d
    .prepare(
      `SELECT id, sent_at FROM nudges
        WHERE user_id = ? AND kind = 'still_looking' AND answered_at IS NULL
        ORDER BY sent_at DESC, id DESC LIMIT 1`,
    )
    .bind(userId)
    .first<{ id: number; sent_at: string }>();
  if (!open) return false;
  await d.batch([
    d.prepare("UPDATE nudges SET answered_at = datetime('now') WHERE id = ?").bind(open.id),
    d.prepare("UPDATE users SET last_active_at = datetime('now') WHERE id = ?").bind(userId),
    // Пауза від тиші: після цього питання є запис inactive_pause; людина відповіла пізно, добірка йде знову.
    d
      .prepare(
        `UPDATE users SET digest_paused = 0
          WHERE id = ?1 AND digest_paused = 1
            AND EXISTS (SELECT 1 FROM nudges p WHERE p.user_id = ?1 AND p.kind = 'inactive_pause' AND p.sent_at >= ?2)`,
      )
      .bind(userId, open.sent_at),
  ]);
  return true;
}
