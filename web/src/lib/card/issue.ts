// Видача картки ролі: одне правило для «Create my card» у профілі й для першої картки одразу
// після анкети (/welcome/score). Картка це знімок поточного балу ролі з іменем для показу.
import { consume } from "@/lib/auth/ratelimit";
import { parseRoles } from "@/lib/roles/catalog";
import { suggestDisplayName } from "./display-name";
import { cardEligibility } from "./eligibility";
import { isRoleKey, type RoleKey } from "./roles";
import { CardInputError, createCard, listActiveCards } from "./store";
import { displayScore } from "./tiers";

/** 20 карток на годину: кожна нова відкликає попередню тієї ж ролі. */
export const CARD_LIMITS = { windowMinutes: 60, maxAttempts: 20, blockMinutes: 60 };

export type IssueResult = { ok: true; slug: string; reused: boolean } | { ok: false; message: string };

type Row = { score: number | null; formula_version: string; roles: string };

/**
 * Створює картку ролі з поточного балу. `reuse`: якщо вже є активна картка з тим самим балом, повертає
 * її, нової не створює (перша картка після анкети; повторне відкриття сторінки нічого не відкликає).
 */
export async function issueCard(
  d: D1Database,
  userId: string,
  input: { role: string; displayName: string; reuse?: boolean },
): Promise<IssueResult> {
  if (!isRoleKey(input.role)) return { ok: false, message: "Unknown role." };
  const role: RoleKey = input.role;
  const row = await d
    .prepare(
      `SELECT s.score, s.formula_version, u.roles
         FROM scores s JOIN users u ON u.id = s.user_id
        WHERE s.user_id = ? AND s.role = ?`,
    )
    .bind(userId, role)
    .first<Row>();
  if (!row || row.score === null || !parseRoles(row.roles).includes(role)) {
    return { ok: false, message: "There is no score for this role yet." };
  }
  const eligible = cardEligibility(role);
  if (!eligible.ok) return { ok: false, message: eligible.reason };

  if (input.reuse) {
    const active = (await listActiveCards(d, userId)).find((c) => c.role === role);
    if (active && displayScore(active.score) === displayScore(row.score)) return { ok: true, slug: active.slug, reused: true };
  }

  const verdict = await consume(`card:${userId}`, CARD_LIMITS, d);
  if (!verdict.allowed) return { ok: false, message: `Too many cards. Try again in ${verdict.retryAfterMinutes} minutes.` };
  try {
    const slug = await createCard(d, {
      userId,
      role,
      score: row.score,
      displayName: input.displayName,
      formulaVersion: row.formula_version,
    });
    return { ok: true, slug, reused: false };
  } catch (err) {
    if (err instanceof CardInputError) return { ok: false, message: err.message };
    throw err;
  }
}

/**
 * Ім'я на першій картці: «@нік» з X (людина його вписала сама), інакше з пошти, інакше загальне.
 * Змінити ім'я можна в профілі, створивши картку заново.
 */
export function firstCardName(xHandle: string | null, email: string | null): string {
  return suggestDisplayName(xHandle, email) || "NextCryptoJob candidate";
}
