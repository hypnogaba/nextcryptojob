// Дані профілю-доказу для картки одним пакетом D1 (4 читання): людина, підключення, факти,
// налаштування. Хто власник, назовні не виходить: сторінка отримує лише вигляд і те, чи ключ підійшов.
import { chosenRoles, type FactRow } from "@/lib/crm/project";
import { DEFAULT_PREFS, keyMatches, loadPrefs, profileKey, type ProfilePrefs } from "./profile-prefs";
import type { ProfileInput } from "./profile";
import { isSlug } from "./slug";

type UserRow = {
  id: string;
  roles: string;
  remote_mode: string | null;
  city: string | null;
  role_text: string | null;
  target_text: string | null;
  telegram_username: string | null;
  email: string | null;
};


const OWNER = "(SELECT user_id FROM cards WHERE slug = ? AND revoked_at IS NULL)";

export type LoadedProfile = { userId: string; input: ProfileInput };

export async function loadProfileInput(db: D1Database, slug: string, now: Date): Promise<LoadedProfile | null> {
  if (!isSlug(slug)) return null;
  const [users, identities, facts] = await db.batch([
    db
      .prepare(
        `SELECT id, roles, remote_mode, city, role_text, target_text, telegram_username, email
           FROM users WHERE id = ${OWNER}`,
      )
      .bind(slug),
    db.prepare(`SELECT kind, value FROM identities WHERE user_id = ${OWNER} ORDER BY id`).bind(slug),
    db.prepare(`SELECT user_id, source, facts_json FROM source_facts WHERE user_id = ${OWNER}`).bind(slug),
  ]);
  const user = (users.results as UserRow[])[0];
  if (!user) return null;
  const prefs: ProfilePrefs = await loadPrefs(db, user.id).catch(() => ({ ...DEFAULT_PREFS }));
  return {
    userId: user.id,
    input: {
      roles: chosenRoles(user.roles),
      remoteMode: user.remote_mode,
      city: user.city,
      roleText: user.role_text,
      targetText: user.target_text,
      telegramUsername: user.telegram_username,
      email: user.email,
      identities: identities.results as { kind: string; value: string }[],
      facts: facts.results as FactRow[],
      prefs,
      now,
    },
  };
}

/** Чи відмикає `given` повний вигляд: ключ поточної версії власника. Без секрета ніколи. */
export async function unlocks(secret: string | undefined, loaded: LoadedProfile, given: string | null): Promise<boolean> {
  const version = loaded.input.prefs.keyVersion;
  if (!secret || !given || version < 1) return false;
  return keyMatches(await profileKey(secret, loaded.userId, version), given);
}

