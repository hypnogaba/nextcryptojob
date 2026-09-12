// Бал однієї людини: ідентичності → збирачі → формула → один пакет запису в D1.
import type { D1Statement } from "../d1.js";
import { FORMULA_VERSION, scorePerson } from "../formula/score.js";
import type { RoleKey, SourceKey } from "../types.js";
import { collectPerson, DEFAULT_DEADLINE_MS, type Outcomes, partialReason, toPersonFacts } from "./collect.js";
import type { Db } from "./db.js";
import { groupIdentities, loadIdentities, plannedSources } from "./identities.js";
import type { CollectorRegistry, EngineEnv } from "./registry.js";

export interface ScoreUserOptions {
  registry: CollectorRegistry;
  db: Db;
  env: EngineEnv;
  /** Зупинка процесу: збір переривається, нічого не пишеться, виклик кидає. */
  signal?: AbortSignal;
  /** Дедлайн на весь збір людини; джерела, що не встигли, стають прогалиною "timeout". */
  deadlineMs?: number;
  /** Годинник формули (вік гаманців), мс. */
  now?: () => number;
}

export type ScoreSummary = {
  userId: string;
  formula: typeof FORMULA_VERSION;
  totalMs: number;
  collectMs: number;
  /** Мс кожного збирача; `gap` є, якщо джерело не дало фактів. */
  sources: Partial<Record<SourceKey, { ms: number; gap?: string; partial?: number }>>;
  gaps: SourceKey[];
  /** Ролі з балом (не null). */
  scored: number;
};

const UPSERT_FACTS =
  "INSERT INTO source_facts (user_id, source, facts_json, gap_reason, fetched_at) VALUES (?, ?, ?, ?, datetime('now')) " +
  "ON CONFLICT (user_id, source) DO UPDATE SET facts_json = excluded.facts_json, gap_reason = excluded.gap_reason, " +
  "fetched_at = excluded.fetched_at";

const UPSERT_SCORE =
  "INSERT INTO scores (user_id, role, score, core, cover, breakdown_json, formula_version, computed_at) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now')) " +
  "ON CONFLICT (user_id, role) DO UPDATE SET score = excluded.score, core = excluded.core, cover = excluded.cover, " +
  "breakdown_json = excluded.breakdown_json, formula_version = excluded.formula_version, computed_at = excluded.computed_at";

/**
 * Зібрати факти людини й перерахувати бал.
 *
 * Запис один пакетом (одна транзакція D1): рядки `source_facts` для кожного доречного джерела
 * (факти або NULL і `gap_reason`; часткова відповідь гаманців: факти і `gap_reason` "partial: …"), видалення рядків джерел, яких людина вже не має, і `scores`
 * за всіма ролями. Або все, або нічого: половини запису після збою не буває.
 */
export async function scoreUser(userId: string, o: ScoreUserOptions): Promise<ScoreSummary> {
  const t0 = performance.now();
  const inputs = groupIdentities(await loadIdentities(o.db, userId));
  const { outcomes, ms: collectMs } = await collectPerson(inputs, {
    registry: o.registry, env: o.env, deadlineMs: o.deadlineMs ?? DEFAULT_DEADLINE_MS,
    ...(o.signal ? { signal: o.signal } : {}),
  });
  o.signal?.throwIfAborted();

  const facts = toPersonFacts(outcomes);
  const result = scorePerson(facts, (o.now ?? Date.now)());
  const planned = plannedSources(inputs);

  const statements: D1Statement[] = [];
  statements.push(planned.length
    ? { sql: `DELETE FROM source_facts WHERE user_id = ? AND source NOT IN (${planned.map(() => "?").join(", ")})`,
        params: [userId, ...planned] }
    : { sql: "DELETE FROM source_facts WHERE user_id = ?", params: [userId] });
  for (const source of planned) {
    const { result: r, partial } = outcomes[source]!;
    // Часткова відповідь: факти пишуться, а адреси без відповіді чи з невідомим видно в gap_reason.
    statements.push({ sql: UPSERT_FACTS,
      params: [userId, source, r.ok ? JSON.stringify(r.facts) : null, r.ok ? partialReason(partial) : r.gap] });
  }
  for (const [role, rr] of Object.entries(result.roles) as Array<[RoleKey, (typeof result.roles)[RoleKey]]>) {
    statements.push({ sql: UPSERT_SCORE,
      params: [userId, role, rr.score, rr.core, rr.cover, JSON.stringify(rr.breakdown), result.formula] });
  }
  // UPSERT і DELETE без приростів: повтор після загубленої відповіді дає той самий стан.
  await o.db.batch(statements, { idempotent: true });

  return summarize(userId, outcomes, collectMs, Math.round(performance.now() - t0),
    Object.values(result.roles).filter((r) => r.score !== null).length);
}

function summarize(userId: string, outcomes: Outcomes, collectMs: number, totalMs: number, scored: number): ScoreSummary {
  const sources: ScoreSummary["sources"] = {};
  const gaps: SourceKey[] = [];
  for (const [source, out] of Object.entries(outcomes) as Array<[SourceKey, NonNullable<Outcomes[SourceKey]>]>) {
    sources[source] = {
      ms: out.ms,
      ...(out.result.ok ? {} : { gap: out.result.gap }),
      ...(out.partial ? { partial: Object.keys(out.partial).length } : {}),
    };
    if (!out.result.ok) gaps.push(source);
  }
  return { userId, formula: FORMULA_VERSION, totalMs, collectMs, sources, gaps, scored };
}
