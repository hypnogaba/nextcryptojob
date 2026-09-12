// Живий прогін без D1: ідентичності з командного рядка → справжні збирачі → формула → друк.
// Для перевірки на людині, яка погодилась (власник), і для заміру часу з машини, де код живе.
import { type PersonScore, scorePerson } from "../formula/score.js";
import { ROLE_ORDER } from "../formula/roles.js";
import type { SourceKey } from "../types.js";
import { collectPerson, DEFAULT_DEADLINE_MS, type Outcomes, toPersonFacts } from "./collect.js";
import type { CollectorInputs } from "./identities.js";
import { inputsFromReference } from "./quality-gate.js";
import type { CollectorRegistry, EngineEnv } from "./registry.js";

export type ScoreFactsArgs = {
  x?: string | null;
  github?: string | null;
  youtube?: string | null;
  site?: string | null;
  evm?: string[];
  solana?: string[];
  sherlock?: string | null;
};

export type ScoreFactsResult = { inputs: CollectorInputs; outcomes: Outcomes; collectMs: number; score: PersonScore };

/** Ключі джерел (§6), про які друкуємо лише «є / немає». */
export const SOURCE_KEYS = ["TWITTER_TOKEN", "GITHUB_TOKEN", "ETHERSCAN_KEY", "BLOCKSCOUT_KEY", "HELIUS_KEY", "YOUTUBE_KEY"] as const;

/**
 * X і GitHub з командного рядка вважаються підтвердженими (як у воротах якості): команду запускають
 * для людини, що погодилась, і профіль Sherlock звіряється з ними.
 */
export function inputsFromArgs(a: ScoreFactsArgs): CollectorInputs {
  return inputsFromReference({
    id: "cli", x: a.x ?? null, github: a.github ?? null, youtube: a.youtube ?? null, site: a.site ?? null,
    evm: a.evm ?? [], sol: a.solana ?? [], sherlock: a.sherlock ?? null, expected_role: "engineer", expected_band: "?",
  });
}

export async function scoreFacts(a: ScoreFactsArgs, o: { registry: CollectorRegistry; env: EngineEnv; deadlineMs?: number; now?: () => number }):
  Promise<ScoreFactsResult> {
  const inputs = inputsFromArgs(a);
  const { outcomes, ms } = await collectPerson(inputs, { registry: o.registry, env: o.env, deadlineMs: o.deadlineMs ?? DEFAULT_DEADLINE_MS });
  return { inputs, outcomes, collectMs: ms, score: scorePerson(toPersonFacts(outcomes), (o.now ?? Date.now)()) };
}

const fmt = (v: number | null | undefined): string => (v === null || v === undefined ? "null" : v.toFixed(1));

/** Друк для людини: ключі (є/немає), час і результат кожного джерела, прогалини, бали джерел і ролей. */
export function formatScoreFacts(r: ScoreFactsResult, env: EngineEnv, deadlineMs: number): string[] {
  const lines: string[] = [];
  lines.push(`keys: ${SOURCE_KEYS.map((k) => `${k} ${env[k]?.trim() ? "set" : "missing"}`).join(", ")}`);
  lines.push(`formula ${r.score.formula}, deadline ${deadlineMs} ms, collected in ${r.collectMs} ms`, "");
  lines.push("source        ms  result");
  for (const [source, out] of Object.entries(r.outcomes) as Array<[SourceKey, NonNullable<Outcomes[SourceKey]>]>) {
    const res = out.result.ok
      ? `ok${out.partial ? ` (partial: ${Object.keys(out.partial).length} address note(s))` : ""}`
      : `gap: ${out.result.gap}`;
    lines.push(`${source.padEnd(12)}${String(out.ms).padStart(6)}  ${res}`);
  }
  const gaps = Object.entries(r.score.roles.engineer.breakdown.gaps);
  lines.push("", gaps.length ? "gaps:" : "gaps: none");
  for (const [k, v] of gaps) lines.push(`  ${k}: ${v}`);
  lines.push("", `sources: ${Object.entries(r.score.sources).map(([k, v]) => `${k}=${fmt(v)}`).join(" ")}`, "");
  lines.push("role                score  level  cover  reason");
  for (const role of ROLE_ORDER) {
    const rr = r.score.roles[role];
    lines.push(`${role.padEnd(18)}${fmt(rr.score).padStart(7)}${String(rr.level ?? "-").padStart(7)}${String(rr.cover).padStart(7)}  ${rr.breakdown.reason ?? ""}`);
  }
  return lines;
}
