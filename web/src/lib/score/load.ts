import type { ScoreRow } from "./explain";

/** Рядки scores людини за роллю. */
export async function loadScores(db: D1Database, userId: string): Promise<Map<string, ScoreRow>> {
  const { results } = await db
    .prepare("SELECT role, score, breakdown_json, formula_version, computed_at FROM scores WHERE user_id = ?")
    .bind(userId)
    .all<ScoreRow>();
  return new Map(results.map((r) => [r.role, r]));
}
