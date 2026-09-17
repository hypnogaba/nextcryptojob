// Ворота якості (план 1.7): еталонні люди → ті самі збирачі й дедлайн, що в продукті → формула →
// звірка з очікуваним рівнем. Межа (реліз 1, рішення власника 13.09): в межах сусіднього рівня ≥ 85%.
// Промахи на 2 рівні не блокують: їх рахуємо й пишемо в звіт (з прогалиною і без), щоб історія їх
// зберігала. Файл еталону (реальні люди) живе поза репозиторієм; у базу йдуть лише id.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ROLE_ORDER } from "../formula/roles.js";
import { V7_ROLES, type V7Source } from "../formula/v7.js";
import { FORMULA_VERSION, type PersonScore, scorePerson } from "../formula/score.js";
import type { RoleKey, SourceKey } from "../types.js";
import { collectPerson, DEFAULT_DEADLINE_MS, type Outcomes, TIMEOUT_GAP, toPersonFacts } from "./collect.js";
import type { Db } from "./db.js";
import { type CollectorInputs, plannedSources } from "./identities.js";
import type { CollectorRegistry, EngineEnv } from "./registry.js";

export type Band = "A" | "B" | "C" | "D";
const ORDER: readonly Band[] = ["D", "C", "B", "A"];
/** Поріг «в межах сусіднього рівня», %. */
export const NEAR_THRESHOLD_PCT = 85;
/** Правило воріт словами: пишеться в кожен звіт, щоб старі рядки quality_runs читались правильно. */
export const GATE_RULE = `within-one >= ${NEAR_THRESHOLD_PCT}%`;

/** Рівні як у research/harness/evaluate2.py: A ≥ 80, B 60–80, C 40–60, D < 40 (бал ролі). */
export const band = (score: number): Band => (score >= 80 ? "A" : score >= 60 ? "B" : score >= 40 ? "C" : "D");
const bandDistance = (a: Band, b: Band): number => Math.abs(ORDER.indexOf(a) - ORDER.indexOf(b));

/** Рядок еталону: та сама форма, що `research/data/people_all.json`, плюс необов'язковий sherlock. */
export type ReferencePerson = {
  id: string;
  name?: string;
  x?: string | null;
  github?: string | null;
  youtube?: string | null;
  site?: string | null;
  evm?: string[] | null;
  sol?: string[] | null;
  sherlock?: string | null;
  expected_role: string;
  expected_band: Band | "?";
};

export type Verdict = "exact" | "near" | "miss2" | "unscored" | "skipped";

/** Результат людини в звіті. Лише id і числа: без імен, ніків і текстів прогалин. */
export type PersonResult = {
  role: string;
  expected: Band | "?";
  score: number | null;
  band: Band | null;
  verdict: Verdict;
  /** Джерела з прогалиною, що живлять цю роль (ключі на кшталт "x", "evm.base"). */
  gaps: string[];
  /** Промах пояснює прогалина в даних. */
  dataGap: boolean;
  reason: string | null;
  ms: number;
};

export type GateReport = {
  formula: typeof FORMULA_VERSION;
  /** Правило, за яким вирішено `passed` (GATE_RULE). */
  rule: string;
  deadlineMs: number;
  /** Скільки людей з очікуваним рівнем (без "?"). */
  people: number;
  exact: number;
  near: number;
  exactPct: number;
  nearPct: number;
  unscored: number;
  /** Промахи на 2 рівні: метрика, не умова воріт. */
  twoBandMisses: Array<{ id: string; dataGap: boolean; gaps: string[] }>;
  twoBandWithGap: number;
  twoBandWithoutGap: number;
  /** Звідки факти: скільки відповідей джерел узято з кешу, скільки зібрано зараз (лише runQualityGate). */
  facts?: { cached: number; collected: number };
  /** Позначка прогону від людини (`--note`), напр. звідки кеш фактів. */
  note?: string;
  passed: boolean;
  failReasons: string[];
  results: Record<string, PersonResult>;
};

/** Які джерела фактів стоять за балом джерела формули. */
const FACT_SOURCES: Record<V7Source, readonly SourceKey[]> = {
  gh_eng: ["github"], gh_builder: ["github"], x: ["x"], yt: ["youtube"],
  onchain: ["evm", "hyperliquid", "solana"], trading: ["evm", "hyperliquid", "solana"], site: ["site"],
  audits: ["audits"], dune: ["dune"], media: ["x", "youtube"], output: ["site", "github", "dune"], links: [],
  best: ["x", "github", "youtube", "site", "evm", "hyperliquid", "solana", "audits"],
};

/** Джерела фактів роботи й головних джерел ролі (репутація й ширина окремо не зсувають на 2 рівні). */
function roleFactSources(role: RoleKey): Set<SourceKey> {
  const out = new Set<SourceKey>();
  const spec = V7_ROLES[role];
  if (!spec) return out;
  const keys = new Set<V7Source>(spec.anchors);
  for (const p of spec.paths) for (const k of Object.keys(p.work) as V7Source[]) keys.add(k);
  for (const k of keys) for (const s of FACT_SOURCES[k]) out.add(s);
  return out;
}

const isRole = (r: string): r is RoleKey => (ROLE_ORDER as readonly string[]).includes(r);

/**
 * Чиста звірка: бал кожної людини → рівень, вердикт і межа воріт.
 * Як evaluate2.py: "?" пропускаємо, роль без балу рахується в знаменнику як «не рахується».
 */
export function evaluateGate(
  people: readonly ReferencePerson[],
  scored: ReadonlyMap<string, { score: PersonScore; ms: number }>,
  deadlineMs: number,
): GateReport {
  const results: Record<string, PersonResult> = {};
  const twoBandMisses: GateReport["twoBandMisses"] = [];
  let n = 0, exact = 0, near = 0, unscored = 0;

  for (const p of people) {
    const s = scored.get(p.id);
    if (!s) throw new Error(`немає балу для ${p.id}`);
    const role = p.expected_role as RoleKey;
    const rr = s.score.roles[role];
    const relevant = roleFactSources(role);
    const gaps = Object.keys(rr?.breakdown.gaps ?? {}).filter((k) => relevant.has(k.split(".")[0] as SourceKey)).sort();
    const base = { role, expected: p.expected_band, score: rr?.score ?? null, gaps, dataGap: gaps.length > 0,
      reason: rr?.breakdown.reason ?? null, ms: s.ms };

    if (p.expected_band === "?") { results[p.id] = { ...base, band: rr?.score == null ? null : band(rr.score), verdict: "skipped" }; continue; }
    n++;
    if (rr?.score == null) { unscored++; results[p.id] = { ...base, band: null, verdict: "unscored" }; continue; }
    const b = band(rr.score);
    const d = bandDistance(b, p.expected_band);
    if (d === 0) exact++;
    if (d <= 1) near++;
    results[p.id] = { ...base, band: b, verdict: d === 0 ? "exact" : d === 1 ? "near" : "miss2" };
    if (d >= 2) twoBandMisses.push({ id: p.id, dataGap: base.dataGap, gaps });
  }

  const pct = (k: number) => (n ? Math.round((k / n) * 1000) / 10 : 0);
  const failReasons: string[] = [];
  if (n === 0) failReasons.push("no reference people with an expected band");
  else if ((near / n) * 100 < NEAR_THRESHOLD_PCT) failReasons.push(`within-one ${pct(near)}% < ${NEAR_THRESHOLD_PCT}%`);
  const withGap = twoBandMisses.filter((m) => m.dataGap).length;

  return { formula: FORMULA_VERSION, rule: GATE_RULE, deadlineMs, people: n, exact, near, exactPct: pct(exact), nearPct: pct(near),
    unscored, twoBandMisses, twoBandWithGap: withGap, twoBandWithoutGap: twoBandMisses.length - withGap,
    passed: failReasons.length === 0, failReasons, results };
}

function list(v: unknown, what: string): string[] {
  if (v == null) return [];
  if (!Array.isArray(v) || v.some((a) => typeof a !== "string")) throw new Error(`${what}: очікував масив рядків`);
  return (v as string[]).map((a) => a.trim()).filter(Boolean);
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** Файл еталону з перевіркою форми; помилка називає номер рядка, а не імена. */
export function parseReferencePeople(json: unknown): ReferencePerson[] {
  if (!Array.isArray(json)) throw new Error("еталон: очікував JSON-масив людей");
  const seen = new Set<string>();
  return json.map((raw, i) => {
    const p = raw as Record<string, unknown>;
    const id = str(p?.id);
    if (!id) throw new Error(`еталон[${i}]: немає id`);
    if (seen.has(id)) throw new Error(`еталон[${i}]: id повторюється`);
    seen.add(id);
    const role = str(p.expected_role);
    if (!role || !isRole(role)) throw new Error(`еталон[${i}]: невідома expected_role`);
    const b = p.expected_band;
    if (b !== "A" && b !== "B" && b !== "C" && b !== "D" && b !== "?") throw new Error(`еталон[${i}]: expected_band має бути A|B|C|D|?`);
    return { id, x: str(p.x), github: str(p.github), youtube: str(p.youtube), site: str(p.site), sherlock: str(p.sherlock),
      evm: list(p.evm, `еталон[${i}].evm`), sol: list(p.sol, `еталон[${i}].sol`), expected_role: role, expected_band: b };
  });
}

/**
 * Входи збирачів з рядка еталону. X і GitHub у еталоні вважаються підтвердженими: це публічні люди
 * з дослідження, чиї профілі звірено вручну (так само Sherlock звіряється з ними).
 */
export function inputsFromReference(p: ReferencePerson): CollectorInputs {
  const x = p.x ? p.x.replace(/^@/, "").toLowerCase() : null;
  const github = p.github ? p.github.replace(/^@/, "").toLowerCase() : null;
  const site = p.site ? (/^https?:\/\//i.test(p.site) ? p.site : `https://${p.site}`).replace(/\/+$/, "") : null;
  return {
    x: x ? { handle: x, verified: true } : null,
    github: github ? { login: github, verified: true } : null,
    youtube: p.youtube ?? null,
    site,
    evm: [...new Set((p.evm ?? []).map((a) => (/^0x[0-9a-f]{40}$/i.test(a) ? a.toLowerCase() : a)))],
    solana: [...new Set(p.sol ?? [])],
    sherlock: p.sherlock ? p.sherlock.toLowerCase() : null,
  };
}

type CacheFile = { version: 1; inputs: CollectorInputs; outcomes: Outcomes };
const cacheName = (id: string): string => `${encodeURIComponent(id)}.json`;

/** Кеш сирих відповідей на людину: джерела з кешу не збираються вдруге, "timeout" збирається знову. */
async function readCache(dir: string, id: string, inputs: CollectorInputs): Promise<Outcomes> {
  let file: CacheFile;
  try { file = JSON.parse(await readFile(join(dir, cacheName(id)), "utf8")) as CacheFile; } catch { return {}; }
  if (file.version !== 1 || JSON.stringify(file.inputs) !== JSON.stringify(inputs)) return {};
  const out: Outcomes = {};
  for (const [k, v] of Object.entries(file.outcomes ?? {}) as Array<[SourceKey, NonNullable<Outcomes[SourceKey]>]>) {
    if (v?.result && !(v.result.ok === false && v.result.gap === TIMEOUT_GAP)) out[k] = v;
  }
  return out;
}

export interface QualityGateOptions {
  registry: CollectorRegistry;
  env: EngineEnv;
  deadlineMs?: number;
  /** Скільки людей збирати одночасно (бюджети провайдерів однаково спільні, limits.ts). */
  concurrency?: number;
  /** Необов'язковий каталог кешу сирих відповідей (поза репозиторієм: це факти про людей). */
  cacheDir?: string | null;
  /** Куди писати рядок quality_runs; null = не писати. */
  db?: Db | null;
  /** Лише кеш: якщо для когось у кеші бракує джерела, прогін падає до будь-якого збору. */
  cacheOnly?: boolean;
  /** Позначка прогону (іде в report_json.note). */
  note?: string | null;
  signal?: AbortSignal;
  now?: () => number;
  log?: (line: string) => void;
}

async function pool<T>(items: readonly T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

/** Прогін воріт: збір, формула, звірка, рядок у quality_runs, короткий друк. */
export async function runQualityGate(people: readonly ReferencePerson[], o: QualityGateOptions): Promise<GateReport> {
  const deadlineMs = o.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const log = o.log ?? ((l: string) => console.log(l));
  const now = o.now ?? Date.now;
  const scored = new Map<string, { score: PersonScore; ms: number }>();
  let cachedN = 0, collectedN = 0;

  if (o.cacheOnly) {
    if (!o.cacheDir) throw new Error("cache-only потребує каталогу кешу");
    let short = 0;
    for (const p of people) {
      const inputs = inputsFromReference(p);
      const cached = await readCache(o.cacheDir, p.id, inputs);
      if (plannedSources(inputs).some((s) => !cached[s])) short++;
    }
    // Лише кількість: id і джерела людей у повідомлення про помилку не йдуть.
    if (short) throw new Error(`cache-only: ${short} people have sources missing from the cache (or other inputs)`);
  }

  await pool(people, o.concurrency ?? 3, async (p) => {
    const inputs = inputsFromReference(p);
    const cached = o.cacheDir ? await readCache(o.cacheDir, p.id, inputs) : {};
    const missing = plannedSources(inputs).filter((s) => !cached[s]);
    cachedN += Object.keys(cached).length;
    collectedN += missing.length;
    const fresh = missing.length
      ? await collectPerson(inputs, { registry: o.registry, env: o.env, deadlineMs, only: missing, ...(o.signal ? { signal: o.signal } : {}) })
      : { outcomes: {}, ms: 0 };
    const outcomes: Outcomes = { ...cached, ...fresh.outcomes };
    if (o.cacheDir && missing.length) {
      await mkdir(o.cacheDir, { recursive: true });
      const file: CacheFile = { version: 1, inputs, outcomes };
      await writeFile(join(o.cacheDir, cacheName(p.id)), JSON.stringify(file));
    }
    scored.set(p.id, { score: scorePerson(toPersonFacts(outcomes), now()), ms: fresh.ms });
  });

  const report: GateReport = { ...evaluateGate(people, scored, deadlineMs), facts: { cached: cachedN, collected: collectedN },
    ...(o.note ? { note: o.note } : {}) };
  if (o.db) {
    await o.db.run(
      "INSERT INTO quality_runs (formula_version, people, exact_pct, near_pct, unscored, report_json, passed) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [report.formula, report.people, report.exactPct, report.nearPct, report.unscored, JSON.stringify(report), report.passed ? 1 : 0]);
  }
  for (const line of formatReport(people, report)) log(line);
  return report;
}

const MARK: Record<Verdict, string> = { exact: "ok  ", near: "near", miss2: "MISS", unscored: "none", skipped: "  ? " };

/** Короткий друк: id, роль, очікуване → бал і рівень, прогалини. Без імен. */
export function formatReport(people: readonly ReferencePerson[], r: GateReport): string[] {
  const lines = people.map((p) => {
    const x = r.results[p.id]!;
    const got = x.score === null ? `unscored (${x.reason ?? "?"})` : `${x.score.toFixed(1)} ${x.band}`;
    const gaps = x.gaps.length ? `  gaps: ${x.gaps.join(",")}` : "";
    return `${MARK[x.verdict]} ${p.id.padEnd(16)} ${x.role.padEnd(18)} exp ${x.expected} → ${got}${gaps}`;
  });
  lines.push("",
    `formula ${r.formula}, deadline ${r.deadlineMs} ms, people ${r.people}: exact ${r.exact} (${r.exactPct}%), ` +
    `within one ${r.near} (${r.nearPct}%), unscored ${r.unscored}`,
    `2-band misses ${r.twoBandMisses.length} (with a data gap ${r.twoBandWithGap}, without ${r.twoBandWithoutGap}; tracked, not a gate rule)`);
  if (r.facts) lines.push(`facts: ${r.facts.cached} source answers from cache, ${r.facts.collected} collected now`);
  if (r.note) lines.push(`note: ${r.note}`);
  lines.push(r.passed ? `quality gate: PASSED (${r.rule})` : `quality gate: FAILED (${r.failReasons.join("; ")})`);
  return lines;
}
