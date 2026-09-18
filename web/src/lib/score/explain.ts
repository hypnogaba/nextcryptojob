// breakdown_json (docs/contracts.md, §4) → те, що людина бачить на сторінці балу:
// смужки джерел, додатки, покриття, прогалини людськими словами й поради,
// яке джерело підняло б бал. Чиста функція, без бази.
import { ROLES, type RoleKey } from "@/lib/card/roles";
import { displayScore, levelFor } from "@/lib/card/tiers";
import type { IdentityKind } from "@/lib/identity/normalize";
import { unscoredNote } from "@/lib/roles/catalog";
import { isLayeredFormula } from "@/lib/roles/recipes";

export type Breakdown = {
  formula?: string;
  core?: Record<string, { weight: number; value: number | null }>;
  bonus?: Record<string, { max: number; value: number | null }>;
  cover?: number;
  level?: number | null;
  reason?: string | null;
  gaps?: Record<string, string>;
  /** v7: три шари балу. */
  layers?: { work: number; rep: number; width: number } | null;
  /** v7: яке джерело найсильніше (для «best»). */
  bestOf?: string | null;
  /** v7: є посилання, додані людиною без перевірки. */
  selfAddedLinks?: boolean;
};

export type ScoreRow = {
  role: string;
  score: number | null;
  breakdown_json: string;
  formula_version: string;
  computed_at: string;
};

export type SourceBar = {
  key: string;
  label: string;
  /** 0–100 або null, коли джерело не дало даних. */
  value: number | null;
  /** Для ядра: частка балу, %. Для додатка: скільки балів може додати. */
  weight: number;
};

export type RoleView =
  | { role: RoleKey; name: string; state: "waiting" }
  | { role: RoleKey; name: string; state: "unscored"; note: string }
  | { role: RoleKey; name: string; state: "missing"; reason: string; tips: string[]; gaps: string[] }
  | {
      role: RoleKey;
      name: string;
      state: "scored";
      score: number;
      level: number;
      core: SourceBar[];
      bonus: SourceBar[];
      cover: number;
      reason: string | null;
      gaps: string[];
      tips: string[];
      formulaVersion: string;
      computedAt: string;
    };

const SOURCE_LABEL: Record<string, string> = {
  gh_eng: "GitHub engineering",
  gh_builder: "GitHub projects",
  x: "X",
  yt: "YouTube",
  media: "X or YouTube",
  onchain: "Onchain activity",
  trading: "Trading",
  site: "Website",
  output: "Published work",
  audits: "Audit contests",
  dune: "Dune Spellbook",
  links: "Links to your work",
  rep: "Reputation",
  best: "Your strongest source",
};

/** Які підключення живлять джерело балу. */
const FEEDS: Record<string, IdentityKind[]> = {
  gh_eng: ["github"],
  gh_builder: ["github"],
  dune: ["github"],
  x: ["x"],
  yt: ["youtube"],
  media: ["x", "youtube"],
  onchain: ["evm", "solana"],
  trading: ["evm", "solana"],
  site: ["site"],
  output: ["site", "github"],
  audits: ["sherlock"],
  rep: ["x", "github"],
  best: ["x", "github", "evm", "youtube", "site"],
};

/** Як назвати підключення в пораді «Connect …». */
const KIND_NAME: Record<IdentityKind, string> = {
  x: "X",
  github: "GitHub",
  youtube: "YouTube",
  site: "your website",
  evm: "a wallet",
  solana: "a wallet",
  sherlock: "Sherlock",
};

/** Як назвати вже підключене: «in your GitHub», «in your wallets». */
const OWN_NAME: Record<IdentityKind, string> = {
  x: "X",
  github: "GitHub",
  youtube: "YouTube",
  site: "website",
  evm: "wallets",
  solana: "wallets",
  sherlock: "Sherlock profile",
};

/** Ключ прогалини (x, github, evm.base, solana, …) → підключення, яке він стосується. */
const GAP_KIND: Record<string, { label: string; kinds: IdentityKind[] }> = {
  x: { label: "X", kinds: ["x"] },
  github: { label: "GitHub", kinds: ["github"] },
  dune: { label: "Dune", kinds: ["github"] },
  evm: { label: "EVM wallets", kinds: ["evm"] },
  hyperliquid: { label: "Hyperliquid", kinds: ["evm"] },
  solana: { label: "Solana wallets", kinds: ["solana"] },
  youtube: { label: "YouTube", kinds: ["youtube"] },
  site: { label: "Website", kinds: ["site"] },
  audits: { label: "Sherlock", kinds: ["sherlock"] },
};

/**
 * Що з підключеного рахується. З 13.09 (модель довіри, docs/DECISIONS.md) усе, що людина вписала:
 * рушій бере X і GitHub без коду. `unverified` лишається порожнім; поле є, щоб поради не
 * змінювали форму.
 */
export type SourceState = { counted: Set<IdentityKind>; unverified: Set<IdentityKind> };

export function sourceState(identities: { kind: IdentityKind; verifiedAt: string | null }[]): SourceState {
  return { counted: new Set(identities.map((i) => i.kind)), unverified: new Set() };
}

/** «Verify GitHub», «Connect X or YouTube», «Connect Sherlock or verify GitHub». */
function actionFor(kinds: IdentityKind[], state: SourceState): string {
  const verify = kinds.filter((k) => state.unverified.has(k));
  const connect = kinds.filter((k) => !state.unverified.has(k) && !state.counted.has(k));
  const parts = [
    connect.length > 0 ? `connect ${namesFor(connect)}` : null,
    verify.length > 0 ? `verify ${namesFor(verify)}` : null,
  ].filter(Boolean) as string[];
  const text = parts.join(" or ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function sourceLabel(key: string): string {
  return SOURCE_LABEL[key] ?? key;
}

function namesFor(kinds: IdentityKind[]): string {
  return [...new Set(kinds.map((k) => KIND_NAME[k]))].join(" or ");
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

function round(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
}

/** Прогалина людськими словами. Причину від рушія як є не показуємо: вона технічна. */
export function gapSentence(key: string, reason: string): string {
  const base = key.split(".")[0];
  const label = GAP_KIND[base]?.label ?? base;
  // Бал, порахований до 13.09, коли X без коду не збирали: наступний перерахунок його прочитає.
  if (/not verified/i.test(reason)) return `${label}: we read it on your next score update.`;
  if (/sample too small/i.test(reason)) return `${label}: not enough transactions yet to judge trading.`;
  if (/^not configured/i.test(reason)) return `${label}: we do not collect this source yet. It does not lower your score.`;
  return `${label}: we could not read it this time. It does not lower your score.`;
}

/** Бал порахований до 13.09, коли X і GitHub без коду не збирали: є прогалина «not verified». */
export function hasStaleVerifyGap(breakdownJson: string | null | undefined): boolean {
  return Object.values(parseBreakdown(breakdownJson ?? "{}").gaps ?? {}).some((g) => /not verified/i.test(g));
}

/** Причина без балу (missing_anchor:…) або пояснення шляху. */
function reasonSentence(role: RoleKey, breakdown: Breakdown, state: SourceState): string | null {
  const reason = breakdown.reason;
  if (!reason) return null;
  const name = ROLES[role].name;
  if (reason === "missing_anchor:best") {
    return `Connect X, GitHub, a wallet or your website, or add links to your work, to get ${article(name)} ${name} score.`;
  }
  if (reason === "missing_anchor:links") {
    return `Add links to your work (portfolio, case studies, articles) in your profile to get ${article(name)} ${name} score.`;
  }
  if (reason.startsWith("missing_anchor:")) {
    const kinds = [...new Set(anchorKinds({ reason }))];
    const have = kinds.filter((k) => state.counted.has(k));
    const stale = have.filter((k) => /not verified/i.test(breakdown.gaps?.[k] ?? ""));
    if (stale.length > 0) {
      return `Update your score: we now count your ${[...new Set(stale.map((k) => OWN_NAME[k]))].join(" and ")} without a code.`;
    }
    if (have.length > 0) {
      const own = [...new Set(have.map((k) => OWN_NAME[k]))].join(" or ");
      return `We found nothing to score for ${name} in your ${own} yet.`;
    }
    return `${actionFor(kinds, state)} to get ${article(name)} ${name} score.`;
  }
  if (reason === "path:audits") return "Scored on your audit contest results.";
  if (reason === "path:gh_eng+x") return "Scored on GitHub and X.";
  if (reason === "path:gh_eng") return "Scored on GitHub.";
  if (reason === "x_only") return "Scored on X only, because we found no published work yet.";
  return null;
}

type Candidate = { kinds: IdentityKind[]; text: string; rank: number };

/** Поради: джерела ролі, яких людина ще не підключила, найважчі спершу. */
function tipsFor(role: RoleKey, breakdown: Breakdown, state: SourceState): string[] {
  const out: Candidate[] = [];
  for (const [key, { weight }] of Object.entries(breakdown.core ?? {})) {
    if (key === "audits") continue; // Sherlock з анкети прибрано (13.09).
    const kinds = (FEEDS[key] ?? []).filter((k) => !state.counted.has(k));
    if (kinds.length === 0 || kinds.length < (FEEDS[key] ?? []).length) continue;
    out.push({ kinds, text: `${actionFor(kinds, state)}: it counts for ${weight}% of this score.`, rank: 1000 + weight });
  }
  for (const [key, { max }] of Object.entries(breakdown.bonus ?? {})) {
    const kinds = (FEEDS[key] ?? []).filter((k) => !state.counted.has(k));
    if (kinds.length === 0 || kinds.length < (FEEDS[key] ?? []).length) continue;
    out.push({ kinds, text: `${actionFor(kinds, state)}: it can add up to ${max} points.`, rank: max });
  }
  // v7/v8: посилання на роботи рахуються в кожній ролі; порада, поки їх немає.
  if (isLayeredFormula(breakdown.formula) && !breakdown.selfAddedLinks && breakdown.reason !== "missing_anchor:links") {
    out.push({ kinds: [], text: "Add links to your work in your profile: they count for every role.", rank: 4 });
  }
  // Без головного джерела про нього вже каже причина; порада повторила б її.
  const anchors = new Set(anchorKinds(breakdown));
  const seen = new Set<string>();
  return out
    .sort((a, b) => b.rank - a.rank)
    .filter((c) => {
      const key = namesFor(c.kinds);
      if (seen.has(key) || c.kinds.some((k) => anchors.has(k))) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3)
    .map((c) => c.text);
}

/**
 * Підключення головних джерел, яких бракує (reason = missing_anchor:<ключі>). Без Sherlock: поле
 * прибрано з анкети (13.09), тож і радити його нікуди.
 */
function anchorKinds(breakdown: Breakdown): IdentityKind[] {
  if (!breakdown.reason?.startsWith("missing_anchor:")) return [];
  return breakdown.reason
    .slice("missing_anchor:".length)
    .split(",")
    .flatMap((k) => FEEDS[k] ?? [])
    .filter((k) => k !== "sherlock");
}

/** Прогалини, що стосуються джерел цієї ролі. */
function gapsFor(breakdown: Breakdown): string[] {
  const used = new Set([
    ...[...Object.keys(breakdown.core ?? {}), ...Object.keys(breakdown.bonus ?? {})].flatMap((k) => FEEDS[k] ?? []),
    ...anchorKinds(breakdown),
  ]);
  return Object.entries(breakdown.gaps ?? {})
    .filter(([key]) => (GAP_KIND[key.split(".")[0]]?.kinds ?? []).some((k) => used.has(k)))
    .map(([key, reason]) => gapSentence(key, reason))
    .filter((s, i, all) => all.indexOf(s) === i);
}

function parseBreakdown(json: string): Breakdown {
  try {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === "object" ? (value as Breakdown) : {};
  } catch {
    return {};
  }
}

/** Вигляд ролі на сторінці балу. `row` = рядок scores або null, якщо балу ще немає. */
export function explainRole(role: RoleKey, row: ScoreRow | null, state: SourceState): RoleView {
  const name = ROLES[role].name;
  const note = unscoredNote(role);
  if (note) return { role, name, state: "unscored", note };
  if (!row) return { role, name, state: "waiting" };

  const breakdown = parseBreakdown(row.breakdown_json);
  const gaps = gapsFor(breakdown);
  const tips = tipsFor(role, breakdown, state);
  if (row.score === null || !Number.isFinite(row.score)) {
    const reason = reasonSentence(role, breakdown, state) ?? `We could not compute ${article(name)} ${name} score yet.`;
    return { role, name, state: "missing", reason, tips, gaps };
  }

  const bars = <T extends { value: number | null }>(entries: Record<string, T> | undefined, weightOf: (e: T) => number) =>
    Object.entries(entries ?? {})
      .map(([key, e]) => ({ key, label: sourceLabel(key), value: round(e.value), weight: weightOf(e) }))
      .sort((a, b) => b.weight - a.weight);

  return {
    role,
    name,
    state: "scored",
    score: displayScore(row.score),
    level: breakdown.level ?? levelFor(row.score),
    core: bars(breakdown.core, (e) => e.weight),
    bonus: bars(breakdown.bonus, (e) => e.max),
    cover: Math.round(breakdown.cover ?? 0),
    reason: reasonSentence(role, breakdown, state),
    gaps,
    tips,
    formulaVersion: row.formula_version,
    computedAt: row.computed_at,
  };
}
