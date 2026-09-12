import { db } from "@/lib/db";

/**
 * Вікняне обмеження спроб на D1 (перенесено з NextRole, src/lib/ratelimit.ts).
 *
 * Стан у таблиці auth_attempts, а не в пам'яті: ізоляти Workers живуть
 * недовго, і лічильник у пам'яті скидався б сам собою.
 *
 * Відмінності від NextRole:
 * - час пише і порівнює SQL (datetime('now', ...)) у форматі SQLite, а не ISO
 *   з коду (docs/contracts.md, §9);
 * - підрахунок одним UPSERT: немає вікна між «прочитав» і «записав».
 *
 * Схема: checkRate() перед дією; recordAttempt() після кожної спроби, яку
 * треба рахувати (запит коду рахується завжди, перевірка коду лише невдала).
 * Спроба номер maxAttempts у вікні ще проходить і ставить блокування.
 */

export type Limits = { windowMinutes: number; maxAttempts: number; blockMinutes: number };

/** `code:email:<email>`: 5 кодів на адресу за годину. */
export const CODE_EMAIL_LIMITS: Limits = { windowMinutes: 60, maxAttempts: 5, blockMinutes: 60 };
/** `code:ip:<ip>`: 20 кодів з однієї адреси IP за годину (з запасом на офіс за NAT). */
export const CODE_IP_LIMITS: Limits = { windowMinutes: 60, maxAttempts: 20, blockMinutes: 60 };
/** `verify:email:<email>`: 10 невдалих перевірок коду за 15 хвилин, на всі коди разом. */
export const VERIFY_EMAIL_LIMITS: Limits = { windowMinutes: 15, maxAttempts: 10, blockMinutes: 15 };

export type RateVerdict = { allowed: boolean; retryAfterMinutes: number };

/** Чи можна діяти. Якщо заблоковано хоч один ключ, чекати до найпізнішого. */
export async function checkRate(...keys: string[]): Promise<RateVerdict> {
  if (keys.length === 0) return { allowed: true, retryAfterMinutes: 0 };
  const row = await db()
    .prepare(
      `SELECT MAX(CAST(strftime('%s', blocked_until) AS INTEGER) - CAST(strftime('%s', 'now') AS INTEGER)) AS wait
         FROM auth_attempts
        WHERE key IN (${keys.map(() => "?").join(", ")}) AND blocked_until > datetime('now')`,
    )
    .bind(...keys)
    .first<{ wait: number | null }>();
  const wait = row?.wait ?? 0;
  if (wait <= 0) return { allowed: true, retryAfterMinutes: 0 };
  return { allowed: false, retryAfterMinutes: Math.ceil(wait / 60) };
}

/**
 * Рахує одну спробу. Нове вікно починається, коли старе минуло; блокування
 * ставиться, щойно лічильник сягає maxAttempts. У SET SQLite бачить старі
 * значення рядка, тому кожен CASE дивиться на стан до цієї спроби.
 */
export async function recordAttempt(key: string, limits: Limits): Promise<void> {
  const windowAgo = `-${limits.windowMinutes} minutes`;
  const blockFor = `+${limits.blockMinutes} minutes`;
  await db()
    .prepare(
      `INSERT INTO auth_attempts (key, attempts, window_start, blocked_until)
       VALUES (?1, 1, datetime('now'), CASE WHEN 1 >= ?2 THEN datetime('now', ?4) END)
       ON CONFLICT(key) DO UPDATE SET
         attempts = CASE WHEN window_start <= datetime('now', ?3) THEN 1 ELSE attempts + 1 END,
         window_start = CASE WHEN window_start <= datetime('now', ?3) THEN datetime('now') ELSE window_start END,
         blocked_until = CASE
           WHEN (CASE WHEN window_start <= datetime('now', ?3) THEN 1 ELSE attempts + 1 END) >= ?2
             THEN datetime('now', ?4)
           WHEN blocked_until > datetime('now') THEN blocked_until
           ELSE NULL
         END`,
    )
    .bind(key, limits.maxAttempts, windowAgo, blockFor)
    .run();
}

/** Успішний вхід стирає лічильник невдач. */
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
