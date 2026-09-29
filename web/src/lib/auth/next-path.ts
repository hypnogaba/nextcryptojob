/**
 * `?next=` для входу: куди повернути людину після входу (наприклад, лист-запрошення в команду).
 * Приймаємо лише шлях цього ж сайту: `/щось`, без схеми, без `//host`, без зворотного слеша й керуючих
 * символів. Усе інше (у тому числі чужі адреси) відкидаємо: інакше вхід був би відкритим перенаправленням.
 */

const MAX_LENGTH = 512;

export function safeNextPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_LENGTH) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  // Зворотний слеш і керуючі символи (браузер трактує "/\host" як "//host"), а також перенос рядка.
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return null;
  // Розбір проти умовного походження: шлях мусить лишитись на ньому.
  try {
    const base = "https://site.invalid";
    const url = new URL(value, base);
    if (url.origin !== base) return null;
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}

/** Адреса входу, що поверне на `next` (лише безпечний шлях; інакше просто /login). */
export function loginPathFor(next: string): string {
  const safe = safeNextPath(next);
  return safe ? `/login?next=${encodeURIComponent(safe)}` : "/login";
}
