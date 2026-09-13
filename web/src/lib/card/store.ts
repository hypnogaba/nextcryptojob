// Картки в D1 (таблиця cards, db/migrations/0005_cards.sql).
// Картка це знімок балу на момент поширення: бал, рівень і ім'я не змінюються.
// Нова картка тієї ж людини й ролі відкликає попередню, тож активна одна.
import type { IdentityKind } from "@/lib/identity/normalize";
import { normalizeDisplayName } from "./display-name";
import { isRoleKey, type RoleKey } from "./roles";
import { isSlug, newSlug } from "./slug";
import { levelFor } from "./tiers";
import type { CardEvidence } from "./view";

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

type EvidenceRow = {
  score: number | null;
  breakdown_json: string | null;
  formula_version: string | null;
  wallet: string | null;
  kinds: string | null;
};

const IDENTITY_KINDS = new Set<IdentityKind>(["x", "github", "youtube", "site", "evm", "solana", "sherlock"]);

/**
 * Те, що стоїть за карткою: поточний рядок scores власника для її ролі,
 * підтверджений гаманець для печатки й підключення, які рахуються. Хто власник,
 * назовні не виходить. null, якщо картки немає або її відкликано.
 */
export async function getCardEvidence(db: D1Database, slug: string): Promise<CardEvidence | null> {
  if (!isSlug(slug)) return null;
  const row = await db
    .prepare(
      `SELECT s.score, s.breakdown_json, s.formula_version,
              (SELECT i.value FROM identities i
                WHERE i.user_id = c.user_id AND i.kind IN ('evm', 'solana') AND i.verified_at IS NOT NULL
                ORDER BY i.created_at, i.value LIMIT 1) AS wallet,
              (SELECT group_concat(k.kind) FROM (SELECT DISTINCT i.kind FROM identities i
                WHERE i.user_id = c.user_id AND (i.verified_at IS NOT NULL OR i.kind NOT IN ('x', 'github'))) k) AS kinds
         FROM cards c LEFT JOIN scores s ON s.user_id = c.user_id AND s.role = c.role
        WHERE c.slug = ? AND c.revoked_at IS NULL`,
    )
    .bind(slug)
    .first<EvidenceRow>();
  if (!row) return null;
  return {
    score: row.score,
    breakdownJson: row.breakdown_json ?? "{}",
    formulaVersion: row.formula_version ?? "",
    wallet: row.wallet,
    connected: (row.kinds ?? "").split(",").filter((k): k is IdentityKind => IDENTITY_KINDS.has(k as IdentityKind)),
  };
}

/** Активні картки людини (одна на роль), для сторінки балу. */
export type ActiveCard = { slug: string; role: RoleKey; score: number; displayName: string; createdAt: string };

export async function listActiveCards(db: D1Database, userId: string): Promise<ActiveCard[]> {
  const { results } = await db
    .prepare(
      "SELECT slug, role, score, display_name, created_at FROM cards WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at",
    )
    .bind(userId)
    .all<{ slug: string; role: string; score: number; display_name: string; created_at: string }>();
  return results
    .filter((r) => isRoleKey(r.role))
    .map((r) => ({
      slug: r.slug,
      role: r.role as RoleKey,
      score: r.score,
      displayName: r.display_name,
      createdAt: r.created_at,
    }));
}
