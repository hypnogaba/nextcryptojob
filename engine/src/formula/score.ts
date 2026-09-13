// Бал людини за ролями, формула v6 (docs/contracts.md §4). Чисті функції, без IO.
import type { PersonFacts, RoleKey } from "../types.js";
import { type CorePath, type ScoredRole, SCORED_ROLES, ROLE_ORDER, UNSCORED_ROLES } from "./roles.js";
import { computeSources, type ScoreSource, type Sources } from "./sources.js";
import { SOLANA_MIN_SAMPLE, solanaSwapsKnown } from "./wallets.js";

export const FORMULA_VERSION = "v6" as const;

export type BreakdownJson = {
  formula: typeof FORMULA_VERSION;
  sources: Sources;
  core: Record<string, { weight: number; value: number | null }>;
  bonus: Record<string, { max: number; value: number | null }>;
  cover: number;
  level: number | null;
  reason: string | null;
  gaps: Record<string, string>;
};

export type RoleResult = { score: number | null; core: number | null; cover: number; level: number | null; breakdown: BreakdownJson };
export type PersonScore = { formula: typeof FORMULA_VERSION; sources: Sources; roles: Record<RoleKey, RoleResult> };

/** Рівень картки 1..10. */
export function levelOf(score: number): number {
  return Math.min(10, Math.floor(score / 10) + 1);
}

/** Одна десята, як показуємо людям і пишемо в базу. */
const r1 = (v: number) => Math.round(v * 10) / 10;
const r1n = (v: number | null) => (v === null ? null : r1(v));

function coreOf(path: CorePath, s: Sources): { value: number; cover: number } {
  let num = 0, den = 0, cover = 0;
  for (const [k, w] of Object.entries(path.core) as Array<[ScoreSource, number]>) {
    num += w * (s[k] ?? 0);
    den += w;
    if (s[k] !== null) cover += w;
  }
  return { value: num / den, cover };
}

/**
 * Причини прогалин для breakdown: від збирача (`gaps`, зокрема `<джерело>.<адреса…>` з часткових
 * відповідей гаманців), з фактів audits/EVM, KOL X (`x.kol`) і невідомі обміни Solana (замала неповна вибірка).
 */
function collectGaps(f: PersonFacts): Record<string, string> {
  const gaps: Record<string, string> = {};
  for (const [k, v] of Object.entries(f.gaps ?? {})) if (v) gaps[k] = v;
  if (f.audits?.gap && !gaps.audits) gaps.audits = f.audits.gap;
  // KOL важить 30 з 100 у балі X; без нього бал X рахується з решти, і людина має бачити чому.
  if (f.x?.kolSourceGap && !gaps.x) gaps["x.kol"] = "KOL followers unavailable";
  for (const perAddr of Object.values(f.evm ?? {})) {
    for (const [chain, c] of Object.entries(perAddr)) if (c?.gap) gaps[`evm.${chain}`] ??= c.gap;
  }
  const unknown = Object.values(f.solana ?? {}).filter((s) => solanaSwapsKnown(s) === null);
  if (!gaps.solana && unknown.length) {
    gaps.solana = unknown.some((s) => s.sampleSeen < SOLANA_MIN_SAMPLE) ? "sample too small" : "swaps unknown";
  }
  return gaps;
}

function scoreRole(spec: ScoredRole, s: Sources, sources: Sources, gaps: Record<string, string>): RoleResult {
  let chosen = spec.paths[0];
  let best = coreOf(chosen, s);
  for (const p of spec.paths.slice(1)) {
    const c = coreOf(p, s);
    if (c.value > best.value) { chosen = p; best = c; }
  }
  let reason: string | null = spec.paths.length > 1 ? `path:${chosen.label}` : null;
  let coreValue = best.value, cover = best.cover;

  const breakdown: BreakdownJson = {
    formula: FORMULA_VERSION, sources,
    core: Object.fromEntries(Object.entries(chosen.core).map(([k, w]) => [k, { weight: w, value: sources[k as ScoreSource] }])),
    bonus: Object.fromEntries(Object.entries(spec.bonus).map(([k, mx]) => [k, { max: mx, value: sources[k as ScoreSource] }])),
    cover, level: null, reason, gaps,
  };

  if (!spec.anchors.some((a) => s[a] !== null && s[a] !== 0)) {
    breakdown.reason = `missing_anchor:${spec.anchors.join(",")}`;
    return { score: null, core: null, cover, level: null, breakdown };
  }

  if (spec.xOnlyFactor !== undefined && s.output === null) {
    coreValue = spec.xOnlyFactor * (s.x ?? 0);
    cover = chosen.core.x ?? 0;
    reason = "x_only";
  }
  const add = (Object.entries(spec.bonus) as Array<[ScoreSource, number]>).reduce((sum, [k, mx]) => sum + (mx * (s[k] ?? 0)) / 100, 0);
  const score = r1(Math.min(100, coreValue + add));
  const level = levelOf(score);
  Object.assign(breakdown, { cover, level, reason });
  return { score, core: r1(coreValue), cover, level, breakdown };
}

/**
 * Бал 0–100 за кожною роллю. `nowMs` лише для віку гаманців.
 * Джерела рахуються без округлення; у результат ідуть з точністю 0,1.
 */
export function scorePerson(facts: PersonFacts, nowMs: number = Date.now()): PersonScore {
  const s = computeSources(facts, nowMs);
  const sources = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, r1n(v)])) as Sources;
  const gaps = collectGaps(facts);
  const roles = {} as Record<RoleKey, RoleResult>;
  for (const role of ROLE_ORDER) {
    if (role in SCORED_ROLES) {
      roles[role] = scoreRole(SCORED_ROLES[role as keyof typeof SCORED_ROLES], s, sources, gaps);
    } else {
      const reason = UNSCORED_ROLES[role as keyof typeof UNSCORED_ROLES];
      roles[role] = { score: null, core: null, cover: 0, level: null,
        breakdown: { formula: FORMULA_VERSION, sources, core: {}, bonus: {}, cover: 0, level: null, reason, gaps } };
    }
  }
  return { formula: FORMULA_VERSION, sources, roles };
}
