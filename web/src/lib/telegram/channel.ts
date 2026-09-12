/**
 * Куди йдуть щоденні вакансії: users.channel = 'email' | 'telegram'.
 * Telegram можна обрати лише з прив'язаним Telegram, пошту лише з поштою:
 * інакше добірці нема куди йти.
 */

export type Channel = "email" | "telegram";

export function isChannel(value: unknown): value is Channel {
  return value === "email" || value === "telegram";
}

export type ChannelResult = "changed" | "unchanged" | "not_linked" | "no_email" | "no_user";

export async function setChannel(d: D1Database, userId: string, channel: Channel): Promise<ChannelResult> {
  const res = await d
    .prepare(
      `UPDATE users SET channel = ?2
        WHERE id = ?1 AND channel <> ?2
          AND CASE ?2 WHEN 'telegram' THEN telegram_id IS NOT NULL ELSE email IS NOT NULL END`,
    )
    .bind(userId, channel)
    .run();
  if (res.meta.changes === 1) return "changed";

  const row = await d
    .prepare("SELECT channel, email, telegram_id FROM users WHERE id = ?")
    .bind(userId)
    .first<{ channel: Channel; email: string | null; telegram_id: string | null }>();
  if (!row) return "no_user";
  if (row.channel === channel) return "unchanged";
  return channel === "telegram" ? "not_linked" : "no_email";
}

export type TelegramStatus = {
  telegramId: string | null;
  username: string | null;
  email: string | null;
  channel: Channel;
};

export async function telegramStatus(d: D1Database, userId: string): Promise<TelegramStatus | null> {
  const row = await d
    .prepare("SELECT telegram_id, telegram_username, email, channel FROM users WHERE id = ?")
    .bind(userId)
    .first<{ telegram_id: string | null; telegram_username: string | null; email: string | null; channel: Channel }>();
  return row
    ? { telegramId: row.telegram_id, username: row.telegram_username, email: row.email, channel: row.channel }
    : null;
}
