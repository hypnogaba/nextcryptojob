import type { TelegramIdentity } from "./telegram-oidc";

/**
 * Людина за Telegram: знайти, створити або прив'язати до профілю, де вже є сесія.
 * users.telegram_id UNIQUE (0001_core): один Telegram належить одному профілю.
 *
 * users.email тут НЕ пишеться ніколи (docs/contracts.md): пошта з'являється
 * лише після перевірки коду з листа, і на ній тримається доступ адміна.
 * Вхід і прив'язка через Telegram чіпають лише telegram_id і telegram_username.
 */

/** Нік міняється в Telegram; пишемо, лише коли він справді інший (жодного запису на кожен вхід). */
function refreshUsername(d: D1Database, userId: string, username: string | null): D1PreparedStatement {
  return d
    .prepare(
      `UPDATE users SET telegram_username = ?2
        WHERE id = ?1 AND COALESCE(telegram_username, '') <> COALESCE(?2, '')`,
    )
    .bind(userId, username);
}

function findByTelegram(d: D1Database, telegramId: string) {
  return d.prepare("SELECT id FROM users WHERE telegram_id = ?").bind(telegramId).first<{ id: string }>();
}

/**
 * Вхід без сесії: профіль із цим Telegram або новий (channel 'telegram').
 * ON CONFLICT робить подвійне натискання й паралельний вхід безпечними.
 * null: профілю немає, а canCreate каже «не створювати» (нові реєстрації закрито
 * в /admin/settings). canCreate питаємо лише тоді, тож вхід того, хто вже є, його не кличе.
 */
export async function signInWithTelegram(
  d: D1Database,
  identity: TelegramIdentity,
  canCreate: () => Promise<boolean> = async () => true,
): Promise<{ userId: string; created: boolean } | null> {
  const existing = await findByTelegram(d, identity.telegramId);
  if (existing) {
    await refreshUsername(d, existing.id, identity.username).run();
    return { userId: existing.id, created: false };
  }
  if (!(await canCreate())) return null;

  const fresh = crypto.randomUUID();
  const inserted = await d
    .prepare(
      `INSERT INTO users (id, telegram_id, telegram_username, channel)
       VALUES (?, ?, ?, 'telegram') ON CONFLICT(telegram_id) DO NOTHING`,
    )
    .bind(fresh, identity.telegramId, identity.username)
    .run();
  if (inserted.meta.changes === 1) return { userId: fresh, created: true };

  const raced = await findByTelegram(d, identity.telegramId);
  if (!raced) throw new Error("user row missing after insert");
  return { userId: raced.id, created: false };
}

export type LinkResult =
  /** Telegram прив'язано до цього профілю. */
  | "linked"
  /** Цей самий Telegram уже був тут. */
  | "already_linked"
  /** Цей Telegram належить іншому профілю. */
  | "taken"
  /** У профілю вже інший Telegram. */
  | "has_other_telegram";

/**
 * «Connect Telegram» з кабінету. Одна інструкція і перевіряє, і пише: Telegram
 * вільний, а в профілю ще немає свого. Паралельний вхід тим самим Telegram
 * натрапить на UNIQUE, і це теж «taken».
 */
export async function linkTelegram(d: D1Database, userId: string, identity: TelegramIdentity): Promise<LinkResult> {
  let changes = 0;
  try {
    const res = await d
      .prepare(
        `UPDATE users SET telegram_id = ?2, telegram_username = ?3
          WHERE id = ?1 AND telegram_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM users WHERE telegram_id = ?2)`,
      )
      .bind(userId, identity.telegramId, identity.username)
      .run();
    changes = res.meta.changes;
  } catch (err) {
    if (err instanceof Error && /UNIQUE/i.test(err.message)) return "taken";
    throw err;
  }
  if (changes === 1) return "linked";

  const row = await d
    .prepare("SELECT telegram_id FROM users WHERE id = ?")
    .bind(userId)
    .first<{ telegram_id: string | null }>();
  if (!row) throw new Error("signed-in user row missing");
  if (row.telegram_id === identity.telegramId) {
    await refreshUsername(d, userId, identity.username).run();
    return "already_linked";
  }
  return row.telegram_id === null ? "taken" : "has_other_telegram";
}

/** Куди вести того, хто повернувся: анкету пройдено → профіль, інакше кабінет. */
export async function homeFor(d: D1Database, userId: string): Promise<"/profile" | "/account"> {
  const row = await d
    .prepare("SELECT onboarding_step FROM users WHERE id = ?")
    .bind(userId)
    .first<{ onboarding_step: string | null }>();
  return row?.onboarding_step === "done" ? "/profile" : "/account";
}
