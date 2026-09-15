import { isScoredRole, ROLE_ORDER } from "@/lib/roles/catalog";
import { ROLES, type RoleKey } from "@/lib/card/roles";
import { levelFor } from "@/lib/card/tiers";
import type { IdentityKind } from "@/lib/identity/normalize";
import { explainRole, sourceState, type RoleView, type ScoreRow } from "@/lib/score/explain";
import { fromSqlTime } from "@/lib/time";

/**
 * /admin/scores і /admin/scores/[userId] (C, docs/plans/2026-09-15-launch-readiness.md):
 * розподіл балів, ворота якості, «підозрілі» бали, і розбір балу однієї людини. Ваги й
 * пояснення читаємо тим самим кодом, що сторінка балу кандидата (lib/score/explain.ts):
 * жодного числа з формули тут не написано вручну.
 *
 * Усі таблиці (scores, identities, source_facts, quality_runs) з ядра (0001): без
 * обробки "no such table", на відміну від lib/contact.ts і lib/testimonials.ts (0023).
 */

/** Ролі, що рахуються в релізі 1, у порядку договору §1. */
export const SCORED_ROLES: RoleKey[] = ROLE_ORDER.filter(isScoredRole);

export type RoleHistogram = { role: RoleKey; name: string; count: number; scoredCount: number; mean: number | null; levels: number[] };

export type SourceGap = { source: string; total: number; gaps: number };

export type SuspiciousRow = { userId: string; email: string | null; role: RoleKey; roleName: string; score: number | null; level: number | null; cover: number | null; reason: "low_cover" | "zero_with_identities" };

export type LatestQualityRun = {
  formulaVersion: string;
  people: number;
  exactPct: number;
  nearPct: number;
  unscored: number;
  passed: boolean;
  runAt: string;
} | null;

export type ScoreDistribution = {
  histograms: RoleHistogram[];
  sourceGaps: SourceGap[];
  latestQualityRun: LatestQualityRun;
  suspicious: SuspiciousRow[];
};

type ScoreDbRow = { user_id: string; role: string; score: number | null; cover: number | null };

/** Огляд /admin/scores: усе одним проходом по scores, source_facts і identities. */
export async function loadScoreDistribution(db: D1Database): Promise<ScoreDistribution> {
  const [scoresRes, gapsRes, qualityRes, identityRes, emailRes] = await Promise.all([
    db.prepare("SELECT user_id, role, score, cover FROM scores").all<ScoreDbRow>(),
    db
      .prepare(
        `SELECT source, COUNT(*) AS total, SUM(CASE WHEN gap_reason IS NOT NULL THEN 1 ELSE 0 END) AS gaps
           FROM source_facts GROUP BY source ORDER BY source`,
      )
      .all<{ source: string; total: number; gaps: number }>(),
    db.prepare("SELECT formula_version, people, exact_pct, near_pct, unscored, passed, run_at FROM quality_runs ORDER BY run_at DESC, id DESC LIMIT 1").first<{
      formula_version: string;
      people: number;
      exact_pct: number;
      near_pct: number;
      unscored: number;
      passed: number;
      run_at: string;
    }>(),
    db.prepare("SELECT DISTINCT user_id FROM identities").all<{ user_id: string }>(),
    db.prepare("SELECT id, email FROM users").all<{ id: string; email: string | null }>(),
  ]);

  const withIdentities = new Set(identityRes.results.map((r) => r.user_id));
  const emailByUser = new Map(emailRes.results.map((r) => [r.id, r.email]));
  const rowsByRole = new Map<string, ScoreDbRow[]>();
  for (const r of scoresRes.results) {
    if (!rowsByRole.has(r.role)) rowsByRole.set(r.role, []);
    rowsByRole.get(r.role)!.push(r);
  }

  const histograms: RoleHistogram[] = SCORED_ROLES.map((role) => {
    const rows = rowsByRole.get(role) ?? [];
    const scored = rows.filter((r) => typeof r.score === "number" && Number.isFinite(r.score));
    const levels = Array(10).fill(0) as number[];
    for (const r of scored) levels[levelFor(r.score as number) - 1]++;
    const mean = scored.length > 0 ? scored.reduce((s, r) => s + (r.score as number), 0) / scored.length : null;
    return { role, name: ROLES[role].name, count: rows.length, scoredCount: scored.length, mean, levels };
  });

  const suspicious: SuspiciousRow[] = [];
  for (const r of scoresRes.results) {
    if (!isScoredRole(r.role as RoleKey)) continue;
    const role = r.role as RoleKey;
    const level = typeof r.score === "number" ? levelFor(r.score) : null;
    const lowCover = level !== null && level >= 8 && (r.cover ?? 0) < 50;
    const zeroWithIdentities = (r.score === null || r.score === 0) && withIdentities.has(r.user_id);
    if (!lowCover && !zeroWithIdentities) continue;
    suspicious.push({
      userId: r.user_id,
      email: emailByUser.get(r.user_id) ?? null,
      role,
      roleName: ROLES[role].name,
      score: r.score,
      level,
      cover: r.cover,
      reason: lowCover ? "low_cover" : "zero_with_identities",
    });
  }
  suspicious.sort((a, b) => (b.level ?? 0) - (a.level ?? 0));

  return {
    histograms,
    sourceGaps: gapsRes.results.map((r) => ({ source: r.source, total: Number(r.total) || 0, gaps: Number(r.gaps) || 0 })),
    latestQualityRun: qualityRes
      ? {
          formulaVersion: qualityRes.formula_version,
          people: qualityRes.people,
          exactPct: qualityRes.exact_pct,
          nearPct: qualityRes.near_pct,
          unscored: qualityRes.unscored,
          passed: qualityRes.passed === 1,
          runAt: qualityRes.run_at,
        }
      : null,
    suspicious: suspicious.slice(0, 100),
  };
}

export type ScoreSearchHit = { userId: string; email: string | null; telegramUsername: string | null; xHandle: string | null };

/** Пошук людини за X-ніком (без @) або поштою, для /admin/scores. */
export async function searchScoreUsers(db: D1Database, query: string): Promise<ScoreSearchHit[]> {
  const q = query.trim().replace(/^@/, "").toLowerCase();
  if (!q) return [];
  const { results } = await db
    .prepare(
      `SELECT u.id AS user_id, u.email, u.telegram_username,
              (SELECT i.value FROM identities i WHERE i.user_id = u.id AND i.kind = 'x' LIMIT 1) AS x_handle
         FROM users u
        WHERE lower(u.email) = ?1
           OR EXISTS (SELECT 1 FROM identities i WHERE i.user_id = u.id AND i.kind = 'x' AND i.value = ?1)
        LIMIT 20`,
    )
    .bind(q)
    .all<{ user_id: string; email: string | null; telegram_username: string | null; x_handle: string | null }>();
  return results.map((r) => ({ userId: r.user_id, email: r.email, telegramUsername: r.telegram_username, xHandle: r.x_handle }));
}

export type UserScoreDetail = {
  userId: string;
  email: string | null;
  telegramUsername: string | null;
  createdAt: string | null;
  identities: { kind: IdentityKind; value: string; verifiedAt: string | null }[];
  roles: { role: RoleKey; view: RoleView }[];
  rawFacts: { source: string; factsJson: string | null; gapReason: string | null; fetchedAt: string }[];
};

/** Розбір балу однієї людини: та сама explainRole, що на її власній сторінці балу. */
export async function loadUserScoreDetail(db: D1Database, userId: string): Promise<UserScoreDetail | null> {
  const user = await db.prepare("SELECT id, email, telegram_username, created_at FROM users WHERE id = ?").bind(userId).first<{
    id: string;
    email: string | null;
    telegram_username: string | null;
    created_at: string;
  }>();
  if (!user) return null;

  const [identitiesRes, scoresRes, factsRes] = await Promise.all([
    db.prepare("SELECT kind, value, verified_at FROM identities WHERE user_id = ? ORDER BY kind").bind(userId).all<{
      kind: string;
      value: string;
      verified_at: string | null;
    }>(),
    db.prepare("SELECT role, score, breakdown_json, formula_version, computed_at FROM scores WHERE user_id = ?").bind(userId).all<ScoreRow>(),
    db.prepare("SELECT source, facts_json, gap_reason, fetched_at FROM source_facts WHERE user_id = ? ORDER BY source").bind(userId).all<{
      source: string;
      facts_json: string | null;
      gap_reason: string | null;
      fetched_at: string;
    }>(),
  ]);

  const identities = identitiesRes.results.map((r) => ({ kind: r.kind as IdentityKind, value: r.value, verifiedAt: r.verified_at }));
  const state = sourceState(identities);
  const scoreByRole = new Map(scoresRes.results.map((r) => [r.role, r]));
  const roles = SCORED_ROLES.map((role) => ({ role, view: explainRole(role, scoreByRole.get(role) ?? null, state) }));

  return {
    userId: user.id,
    email: user.email,
    telegramUsername: user.telegram_username,
    createdAt: user.created_at,
    identities,
    roles,
    rawFacts: factsRes.results.map((r) => ({ source: r.source, factsJson: r.facts_json, gapReason: r.gap_reason, fetchedAt: r.fetched_at })),
  };
}

/** Дата для показу в адмінці, без винятку на криву мітку. */
export function safeDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  try {
    return fromSqlTime(value);
  } catch {
    return null;
  }
}
