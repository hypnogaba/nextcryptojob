// Картки в D1 (таблиця cards, db/migrations/0005_cards.sql).
// Картка це знімок балу на момент поширення: бал, рівень і ім'я не змінюються.
// Нова картка тієї ж людини й ролі відкликає попередню, тож активна одна.
import { normalizeDisplayName } from "./display-name";
import { isRoleKey, type RoleKey } from "./roles";
import { isSlug, newSlug } from "./slug";
import { levelFor } from "./tiers";

export type NewCard = {
  userId: string;
  role: string;
  score: number;
  displayName: string;
  formulaVersion: string;
};

/** Те, що бачить відвідувач. Без user_id: публічна сторінка не знає, чия це картка. */
export type PublicCard = {
  slug: string;
  role: RoleKey;
  score: number;
  level: number;
  displayName: string;
  formulaVersion: string;
  /** SQLite `YYYY-MM-DD HH:MM:SS`, UTC. */
  createdAt: string;
};

type CardRow = {
  slug: string;
  role: string;
  score: number;
  level: number;
  display_name: string;
  formula_version: string;
  created_at: string;
};

export class CardInputError extends Error {}

/** Створює картку й повертає slug. Кидає CardInputError на хибний вхід. */
export async function createCard(db: D1Database, input: NewCard): Promise<string> {
  if (!input.userId) throw new CardInputError("userId is required.");
  if (!isRoleKey(input.role)) throw new CardInputError(`Unknown role: ${input.role}`);
  if (!Number.isFinite(input.score) || input.score < 0 || input.score > 100) {
    throw new CardInputError(`Score must be between 0 and 100, got ${input.score}`);
  }
  if (!input.formulaVersion) throw new CardInputError("formulaVersion is required.");
  let displayName: string;
  try {
    displayName = normalizeDisplayName(input.displayName);
  } catch (e) {
    throw new CardInputError((e as Error).message);
  }

  // Збіг slug (1 з 2^60) зірве вставку, і batch відкотить і відкликання теж.
  const slug = newSlug();
  await db.batch([
    db
      .prepare(
        "UPDATE cards SET revoked_at = datetime('now') WHERE user_id = ? AND role = ? AND revoked_at IS NULL",
      )
      .bind(input.userId, input.role),
    db
      .prepare(
        "INSERT INTO cards (slug, user_id, role, score, level, display_name, formula_version) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        slug,
        input.userId,
        input.role,
        input.score,
        levelFor(input.score),
        displayName,
        input.formulaVersion,
      ),
  ]);
  return slug;
}

/** Активна картка за slug або null (немає, відкликана, хибний slug, невідома роль). */
export async function getCard(db: D1Database, slug: string): Promise<PublicCard | null> {
  if (!isSlug(slug)) return null;
  const row = await db
    .prepare(
      "SELECT slug, role, score, level, display_name, formula_version, created_at " +
        "FROM cards WHERE slug = ? AND revoked_at IS NULL",
    )
    .bind(slug)
    .first<CardRow>();
  if (!row || !isRoleKey(row.role)) return null;
  return {
    slug: row.slug,
    role: row.role,
    score: row.score,
    level: row.level,
    displayName: row.display_name,
    formulaVersion: row.formula_version,
    createdAt: row.created_at,
  };
}
