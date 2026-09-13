// Кеш воріт якості з фактів дослідження: research/data (raw_all.json, raw_extra.json, people_all.json,
// extra_handles.json) → <out>/people.json + <out>/cache/<id>.json у форматі кешу `quality-gate`.
// Так рушій на VPS проганяє ворота на тих самих фактах, що й дослідження (`--cache-only`: без мережі).
//
// Запуск (локально, у engine/): npx tsc -p tsconfig.scripts.json &&
//   node dist-scripts/scripts/research-cache.js ../research/data <out-dir>
// У <out-dir> реальні люди: файли 600, каталоги 700, поза репозиторієм, видалити після прогону.
// Друкує лише зведення: кількість людей і джерел, звірку балів з adaptHarness і очікуваний результат воріт.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scorePerson } from "../src/formula/score.js";
import { type Outcomes, type SourceOutcome, toPersonFacts } from "../src/pipeline/collect.js";
import { plannedSources } from "../src/pipeline/identities.js";
import { evaluateGate, formatReport, inputsFromReference, parseReferencePeople } from "../src/pipeline/quality-gate.js";
import type { PersonFacts, SourceKey } from "../src/types.js";
import { adaptHarness, type RawExtra, type RawPerson } from "./adapt-harness.js";

/** Джерело, яке еталон планує, а в дослідженні його немає: прогалина, а не вигаданий нуль. */
export const NOT_IN_RESEARCH = "not in research cache";

const FACT_KEYS: readonly SourceKey[] = ["x", "github", "youtube", "site", "evm", "hyperliquid", "solana", "audits", "dune"];

/**
 * Відповіді джерел, з яких `toPersonFacts` відтворює `facts`: факти → ok, null з причиною → прогалина.
 * Джерела, яких еталон не планує, теж лишаються (кеш віддає все, що в ньому є).
 */
export function outcomesFromFacts(facts: PersonFacts, planned: readonly SourceKey[]): Outcomes {
  const out: Outcomes = {};
  const gaps = (facts.gaps ?? {}) as Record<string, string>;
  for (const k of FACT_KEYS) {
    const v = (facts as Record<string, unknown>)[k];
    let o: SourceOutcome | null = null;
    if (v !== undefined && v !== null) o = { result: { ok: true, facts: finite(k, v) }, ms: 0 };
    else if (gaps[k]) o = { result: { ok: false, gap: gaps[k]! }, ms: 0 };
    else if (v === null) o = { result: { ok: true, facts: null }, ms: 0 };
    else if (planned.includes(k)) o = { result: { ok: false, gap: NOT_IN_RESEARCH }, ms: 0 };
    if (o) out[k] = o;
  }
  return out;
}

/**
 * JSON не має Infinity: adaptHarness ставить sampleSeen = Infinity («вибірку не робили, не замала»).
 * MAX_SAFE_INTEGER дає ту саму поведінку (≥ 50 і ≠ sigsOk) і переживає запис у файл.
 */
function finite(k: SourceKey, v: unknown): unknown {
  if (k !== "solana") return v;
  const sol = v as Record<string, { sampleSeen: number }>;
  return Object.fromEntries(Object.entries(sol).map(([a, s]) =>
    [a, Number.isFinite(s.sampleSeen) ? s : { ...s, sampleSeen: Number.MAX_SAFE_INTEGER }]));
}

function main(): void {
  const [dataDir, outDir] = process.argv.slice(2);
  if (!dataDir || !outDir) {
    console.error("usage: node dist-scripts/scripts/research-cache.js <research/data> <out-dir>");
    process.exit(2);
  }
  const read = (f: string) => JSON.parse(readFileSync(join(dataDir, f), "utf8")) as unknown;
  const raw = read("raw_all.json") as Record<string, RawPerson>;
  const extra = (existsSync(join(dataDir, "raw_extra.json")) ? read("raw_extra.json") : {}) as Record<string, RawExtra>;
  const handles = (existsSync(join(dataDir, "extra_handles.json")) ? read("extra_handles.json") : {}) as Record<string, { sherlock?: string }>;
  const peopleRaw = read("people_all.json") as Array<Record<string, unknown>>;

  // Еталон для VPS: лише поля воріт (без імен), ніки Sherlock з extra_handles.json, як 12.09.
  const keep = ["id", "x", "github", "youtube", "site", "evm", "sol", "expected_role", "expected_band"];
  const refRows = peopleRaw.map((p) => {
    const row: Record<string, unknown> = Object.fromEntries(keep.filter((k) => k in p).map((k) => [k, p[k]]));
    const sherlock = handles[String(p.id)]?.sherlock;
    if (sherlock) row.sherlock = sherlock;
    return row;
  });
  const people = parseReferencePeople(refRows);

  mkdirSync(join(outDir, "cache"), { recursive: true, mode: 0o700 });
  writeFileSync(join(outDir, "people.json"), JSON.stringify(refRows), { mode: 0o600 });

  let maxDiff = 0, notInResearch = 0, sources = 0;
  const scored = new Map<string, { score: ReturnType<typeof scorePerson>; ms: number }>();
  const now = Date.now();
  for (const p of people) {
    const r = raw[p.id];
    if (!r) throw new Error("people_all.json має людину, якої немає в raw_all.json");
    const inputs = inputsFromReference(p);
    const facts = adaptHarness(r, extra[p.id]);
    const outcomes = outcomesFromFacts(facts, plannedSources(inputs));
    const file = { version: 1 as const, inputs, outcomes };
    writeFileSync(join(outDir, "cache", `${encodeURIComponent(p.id)}.json`), JSON.stringify(file), { mode: 0o600 });

    // Звірка: бали з кешу після запису у файл = бали з adaptHarness (тих, що в `npm run parity`).
    const back = (JSON.parse(JSON.stringify(file)) as typeof file).outcomes;
    const fromCache = scorePerson(toPersonFacts(back), now);
    const direct = scorePerson(facts, now);
    for (const [role, rr] of Object.entries(direct.roles)) {
      const c = fromCache.roles[role as keyof typeof direct.roles];
      if ((rr.score === null) !== (c.score === null)) maxDiff = Infinity;
      else if (rr.score !== null) maxDiff = Math.max(maxDiff, Math.abs(rr.score - c.score!));
    }
    sources += Object.keys(outcomes).length;
    notInResearch += Object.values(outcomes).filter((o) => !o!.result.ok && o!.result.gap === NOT_IN_RESEARCH).length;
    scored.set(p.id, { score: fromCache, ms: 0 });
  }

  const report = evaluateGate(people, scored, 0);
  console.log(`research-cache: ${people.length} people, ${sources} source answers, ${notInResearch} planned sources ` +
    `not in the research data (written as gap "${NOT_IN_RESEARCH}")`);
  console.log(`scores from cache vs adaptHarness: max diff ${maxDiff.toFixed(3)}`);
  console.log("expected gate result:");
  for (const line of formatReport(people, report).slice(people.length + 1)) console.log(`  ${line}`);
  if (!(maxDiff === 0)) process.exit(1);
}

function isEntry(): boolean {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isEntry()) main();
