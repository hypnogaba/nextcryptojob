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
    // Раунд 5, п.7: ОДНА картка на людину, не на (людина, роль): нова картка (будь-якої ролі)
    // відкликає всі інші активні картки цієї людини, і стара адреса /c/<slug> веде на нову
    // (redirect_to, читає web/src/app/c/[slug]/page.tsx). idx_cards_active_user (0024) тримає це:
    // без цього UPDATE спершу вставка нижче впала б на unique(user_id) WHERE revoked_at IS NULL,
    // бо стара картка ще активна. redirect_to без FK навмисно (0024): new slug ще не існує тут.
    db
      .prepare("UPDATE cards SET revoked_at = datetime('now'), redirect_to = ? WHERE user_id = ? AND revoked_at IS NULL")
      .bind(slug, input.userId),
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
  self_reported: number | null;
};

const IDENTITY_KINDS = new Set<IdentityKind>(["x", "github", "youtube", "site", "evm", "solana", "sherlock"]);

/**
 * Те, що стоїть за карткою: поточний рядок scores власника для її ролі,
 * підтверджений гаманець для печатки, підключення, які рахуються (з 13.09 усі), і чи є серед
 * них самозаявлені (без підтвердження). Хто власник,
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
                WHERE i.user_id = c.user_id) k) AS kinds,
              EXISTS (SELECT 1 FROM identities i WHERE i.user_id = c.user_id AND i.verified_at IS NULL) AS self_reported
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
    selfReported: row.self_reported === 1,
  };
}

/**
 * Куди веде стара адреса /c/<slug> прибраної картки (п.7, раунд 5): slug чинної картки цієї ж
 * людини, чи null (картку не відкликали заради консолідації, чи чинної картки більше нема).
 * Код лишається робочим навіть до накочення 0024: без стовпця redirect_to читання ловить
 * "no such column" і повертає null, як і без самої картки.
 */
export async function getCardRedirect(db: D1Database, slug: string): Promise<string | null> {
  if (!isSlug(slug)) return null;
  try {
    const row = await db
      .prepare("SELECT redirect_to FROM cards WHERE slug = ? AND revoked_at IS NOT NULL AND redirect_to IS NOT NULL")
      .bind(slug)
      .first<{ redirect_to: string }>();
    return row?.redirect_to ?? null;
  } catch {
    return null;
  }
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
