import { db } from "@/lib/db";

/**
 * Вікняне обмеження спроб на D1 (за мотивами NextRole, src/lib/ratelimit.ts).
 *
 * Стан у таблиці auth_attempts, а не в пам'яті: ізоляти Workers живуть
 * недовго, і лічильник у пам'яті скидався б сам собою.
 *
 * Відмінності від NextRole:
 * - одна інструкція consume() і рахує спробу, і вирішує, чи пустити. У
 *   NextRole «перевірив» і «записав» були двома запитами, і 30 паралельних
 *   запитів проходили перевірку всі разом, до першого запису;
 * - час пише і порівнює SQL (datetime('now', ...)) у форматі SQLite, а не ISO
 *   з коду (docs/contracts.md, §9).
 */

export type Limits = { windowMinutes: number; maxAttempts: number; blockMinutes: number };

/** `code:email:<email>`: 5 кодів на адресу за годину. */
export const CODE_EMAIL_LIMITS: Limits = { windowMinutes: 60, maxAttempts: 5, blockMinutes: 60 };
/** `code:email:day:<email>`: 10 кодів на адресу за добу. */
export const CODE_EMAIL_DAY_LIMITS: Limits = { windowMinutes: 24 * 60, maxAttempts: 10, blockMinutes: 24 * 60 };
/** `code:ip:<ip>`: 20 кодів з однієї адреси IP за годину (з запасом на офіс за NAT). */
export const CODE_IP_LIMITS: Limits = { windowMinutes: 60, maxAttempts: 20, blockMinutes: 60 };
/** `verify:email:<email>`: 10 перевірок коду за 15 хвилин, на всі коди разом. */
export const VERIFY_EMAIL_LIMITS: Limits = { windowMinutes: 15, maxAttempts: 10, blockMinutes: 15 };

/** `export:<user id>`: 10 вивантажень своїх даних на годину (файл збирається з багатьох таблиць). */
export const EXPORT_LIMITS: Limits = { windowMinutes: 60, maxAttempts: 10, blockMinutes: 60 };

export type RateVerdict = { allowed: boolean; retryAfterMinutes: number };

/**
 * Рахує одну спробу й каже, чи її пропустити. Одна інструкція UPSERT, тож
 * паралельні запити бачать лічильник по черзі (D1 виконує інструкції бази
 * послідовно) і пропускається рівно maxAttempts за вікно.
 *
 * У SET SQLite бачить значення рядка ДО цієї спроби:
 * - вікно минуло → лічильник з 1 і нове вікно;
 * - блокування ще діє → лишається як є (не продовжується);
 * - лічильник з цією спробою перевищив maxAttempts → блокування на blockMinutes.
 * RETURNING віддає стан ПІСЛЯ: відмова, якщо лічильник > maxAttempts або
 * блокування діє (було до цієї спроби або щойно поставлене).
 */
export async function consume(key: string, limits: Limits, d: D1Database = db()): Promise<RateVerdict> {
  const row = await d
    .prepare(
      `INSERT INTO auth_attempts (key, attempts, window_start, blocked_until)
       VALUES (?1, 1, datetime('now'), CASE WHEN 1 > ?2 THEN datetime('now', ?4) END)
       ON CONFLICT(key) DO UPDATE SET
         attempts = CASE WHEN window_start <= datetime('now', ?3) THEN 1 ELSE attempts + 1 END,
         window_start = CASE WHEN window_start <= datetime('now', ?3) THEN datetime('now') ELSE window_start END,
         blocked_until = CASE
           WHEN blocked_until > datetime('now') THEN blocked_until
           WHEN (CASE WHEN window_start <= datetime('now', ?3) THEN 1 ELSE attempts + 1 END) > ?2
             THEN datetime('now', ?4)
           ELSE NULL
         END
       RETURNING attempts,
         CASE WHEN blocked_until > datetime('now')
           THEN CAST(strftime('%s', blocked_until) AS INTEGER) - CAST(strftime('%s', 'now') AS INTEGER)
           ELSE 0 END AS wait`,
    )
    .bind(key, limits.maxAttempts, `-${limits.windowMinutes} minutes`, `+${limits.blockMinutes} minutes`)
    .first<{ attempts: number; wait: number }>();
  if (!row) throw new Error("rate limit upsert returned nothing");
  if (row.attempts > limits.maxAttempts || row.wait > 0) {
    return { allowed: false, retryAfterMinutes: Math.max(1, Math.ceil(row.wait / 60)) };
  }
  return { allowed: true, retryAfterMinutes: 0 };
}

/** Успішний вхід стирає лічильник. */
export async function clearRate(key: string): Promise<void> {
  await db().prepare("DELETE FROM auth_attempts WHERE key = ?").bind(key).run();
}

/**
 * Прибирання старих лічильників: у ключах лежать пошти й IP, тож тримати
 * їх довше за добу немає причини. Інструкція для пакета (batch).
 */
export function pruneRateStatement(d: D1Database): D1PreparedStatement {
  return d.prepare(
    `DELETE FROM auth_attempts
      WHERE window_start < datetime('now', '-1 day')
        AND (blocked_until IS NULL OR blocked_until < datetime('now'))`,
  );
}

/** Адреса людини. На Cloudflare це заголовок cf-connecting-ip; поза ним спільний кошик. */
export function clientIp(headers: Headers): string {
  return headers.get("cf-connecting-ip")?.trim() || "unknown";
}
