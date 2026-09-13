import { hmacSha256Hex, hmacSha256Verify } from "@/lib/auth/hash";

/**
 * «Відписатись» з листа добірки одним натисканням (RFC 8058).
 *
 * Адреса: POST /api/digest/unsubscribe?u=<user_id>&t=<HMAC(ключ, "unsub:" + user_id)>.
 * Поштові сервіси шлють POST самі (List-Unsubscribe-Post), людина натискає
 * кнопку на сторінці, яку віддає GET тієї ж адреси. GET нічого не змінює:
 * сканери посилань у поштових скриньках відкривають їх без людини.
 * Дія та сама, що /stop у боті: users.digest_paused = 1, канал не чіпаємо.
 */

export const UNSUBSCRIBE_PATH = "/api/digest/unsubscribe";

type Keys = { SESSION_SECRET?: string; INTERNAL_API_SECRET?: string };

/** Ключ підпису посилання. SESSION_SECRET є у продакшені завжди; INTERNAL_API_SECRET як запас. */
export function unsubscribeKey(env: Keys): string | null {
  return env.SESSION_SECRET || env.INTERNAL_API_SECRET || null;
}

const message = (userId: string) => `unsub:${userId}`;

/** Повна адреса відписки для людини, від походження сайту. */
export async function unsubscribeUrl(site: string, key: string, userId: string): Promise<string> {
  const url = new URL(UNSUBSCRIBE_PATH, site);
  url.searchParams.set("u", userId);
  url.searchParams.set("t", await hmacSha256Hex(key, message(userId)));
  return url.toString();
}

/** user_id з адреси, якщо підпис збігся (порівняння за сталий час), інакше null. */
export async function verifyUnsubscribe(key: string, params: URLSearchParams): Promise<string | null> {
  const userId = params.get("u") ?? "";
  const token = params.get("t") ?? "";
  if (userId.length === 0 || userId.length > 64 || !/^[0-9a-f]{64}$/i.test(token)) return null;
  return (await hmacSha256Verify(key, message(userId), token)) ? userId : null;
}

/**
 * Пауза добірки. true, якщо прапор справді змінився (тоді й запис у журнал,
 * як у бота). Повтор нічого не пише: вдруге натиснута відписка це не нова дія.
 */
export async function pauseDigest(d: D1Database, userId: string): Promise<boolean> {
  const res = await d
    .prepare("UPDATE users SET digest_paused = 1 WHERE id = ? AND digest_paused <> 1")
    .bind(userId)
    .run();
  if (res.meta.changes !== 1) return false;
  await d
    .prepare("INSERT INTO audit_log (actor, action, target, meta_json) VALUES (?, 'digest.unsubscribe', ?, ?)")
    .bind(userId, userId, JSON.stringify({ digest_paused: true }))
    .run();
  return true;
}
