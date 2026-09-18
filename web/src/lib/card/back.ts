// Зворот картки: бал, розкладений по рядках формули (v5, v6, v7; docs/contracts.md, §4). Ваги беруться з
// breakdown_json, тож зворот показує ту версію, якою бал пораховано.
// Джерело, вага, значення, бали; окремо ядро, додатки й покриття. Джерело без
// даних друкується як «none» з причиною людськими словами: null ніколи не 0.
//
// v5–v6: core = Σ w·(s ?? 0) / Σ w, bonus = Σ max·(s ?? 0) / 100, score = min(100, core + bonus).
// v7: core («Робота») = Σ w·(s ?? 0) / 100 (ваги вже в балах, разом 60); bonus = репутація (rep) і ширина.
// Для data_research без опублікованої роботи (reason = 'x_only') ядро = 0.8·X.
import type { IdentityKind } from "@/lib/identity/normalize";
import { isLayeredFormula, isSourceKey, SOURCE_CODE, SOURCE_NAME } from "@/lib/roles/recipes";
import type { Breakdown } from "@/lib/score/explain";

export type BackLine = {
  key: string;
  name: string;
  code: string;
  kind: "core" | "bonus";
  /** Для ядра вага (частка з 100), для додатка максимум балів. */
  weight: number;
  /** 0–100 з точністю 0.1 або null, коли джерело не дало даних. */
  value: number | null;
  /** Скільки балів рядок додав (0.1). */
  points: number;
  /** Те саме без округлення: суми рахуємо з нього, щоб не набігала похибка. */
  exact: number;
  /** Чому немає значення, або null. */
  reason: string | null;
};

export type CardBack = {
  lines: BackLine[];
  core: number;
  bonus: number;
  /** Покриття ядра, %. */
  cover: number;
  /** Пояснення шляху (аудити, лише X) або null. */
  note: string | null;
  /** v7: суми називаються «Work» і «Reputation and breadth». */
  layered: boolean;
};

/** Які підключення живлять джерело (як FEEDS у score/explain.ts). */
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
  links: [],
  rep: ["x", "github"],
  best: [],
};

/** Ключ прогалини (x, evm.base, solana.BGjMfx5B, …) → підключення. Хвіст після крапки не показуємо ніколи. */
const GAP_KINDS: Record<string, IdentityKind[]> = {
  x: ["x"],
  github: ["github"],
  dune: ["github"],
  evm: ["evm"],
  hyperliquid: ["evm"],
  solana: ["solana"],
  youtube: ["youtube"],
  site: ["site"],
  audits: ["sherlock"],
};

const NOT_CONNECTED: Record<string, string> = {
  gh_eng: "no GitHub linked",
  gh_builder: "no GitHub linked",
  dune: "no GitHub linked",
  x: "no X linked",
  yt: "no YouTube linked",
  media: "no X or YouTube linked",
  onchain: "no wallet linked",
  trading: "no wallet linked",
  site: "no website linked",
  output: "no website or GitHub linked",
  audits: "no audit contests found",
  links: "no links to your work added",
  rep: "no X or GitHub linked",
};

function gapReason(raw: string): string {
  if (/not verified/i.test(raw)) return "not verified yet";
  if (/sample too small/i.test(raw)) return "too few trades to judge";
  if (/^not configured/i.test(raw)) return "we do not collect it yet";
  if (/Sherlock|no contests/i.test(raw)) return "no audit contests found";
  return "we could not read it this time";
}

/**
 * Причина порожнього джерела. `connected` = підключення, які рушій рахує
 * (sourceState().counted); без нього причина загальніша.
 */
export function missingReason(key: string, gaps: Record<string, string>, connected?: ReadonlySet<IdentityKind> | null): string {
  const feeds = FEEDS[key] ?? [];
  for (const [gapKey, raw] of Object.entries(gaps)) {
    const kinds = GAP_KINDS[gapKey.split(".")[0]] ?? [];
    if (kinds.some((k) => feeds.includes(k))) return gapReason(raw);
  }
  if (connected && feeds.length > 0 && !feeds.some((k) => connected.has(k))) return NOT_CONNECTED[key] ?? "not linked";
  return "no public data found";
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function parse(json: string | Breakdown): Breakdown {
  if (typeof json !== "string") return json;
  try {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === "object" ? (value as Breakdown) : {};
  } catch {
    return {};
  }
}

/** Зворот з breakdown_json. null, якщо в ньому немає ядра (бал не пораховано). */
export function cardBack(json: string | Breakdown, connected?: ReadonlySet<IdentityKind> | null): CardBack | null {
  const b = parse(json);
  const coreEntries = Object.entries(b.core ?? {});
  if (coreEntries.length === 0) return null;
  const gaps = b.gaps ?? {};
  const xOnly = b.reason === "x_only";
  const layered = isLayeredFormula(b.formula);
  // v7/v8: ваги роботи вже в балах, тож ділимо на 100, а не на суму ваг.
  const totalWeight = layered ? 100 : coreEntries.reduce((s, [, e]) => s + (num(e.weight) ?? 0), 0) || 100;

  const line = (key: string, kind: BackLine["kind"], weight: number, value: number | null, points: number): BackLine => ({
    key,
    name: isSourceKey(key) ? SOURCE_NAME[key] : key,
    code: isSourceKey(key) ? SOURCE_CODE[key] : key.slice(0, 3).toUpperCase(),
    kind,
    weight,
    value,
    points: r1(points),
    exact: points,
    reason: value === null ? missingReason(key, gaps, connected) : null,
  });

  const core = coreEntries
    .map(([key, e]) => {
      const value = num(e.value);
      let weight = num(e.weight) ?? 0;
      let points = (weight * (value ?? 0)) / totalWeight;
      if (xOnly) {
        // Без опублікованої роботи ядро = 0.8·X: X важить 80, решта ядра 0.
        weight = key === "x" ? 80 : 0;
        points = key === "x" ? 0.8 * (value ?? 0) : 0;
      }
      return line(key, "core", weight, value, points);
    })
    .sort((a, z) => z.weight - a.weight);

  const bonus = Object.entries(b.bonus ?? {})
    .map(([key, e]) => {
      const value = num(e.value);
      const max = num(e.max) ?? 0;
      return line(key, "bonus", max, value, (max * (value ?? 0)) / 100);
    })
    .sort((a, z) => z.weight - a.weight);

  const sum = (ls: BackLine[]) => r1(ls.reduce((s, l) => s + l.exact, 0));
  return {
    lines: [...core, ...bonus],
    core: sum(core),
    // v8: ширина обрізається на 20, тож сума рядків може бути більшою; рушій уже порахував шари.
    bonus: layered && b.layers ? r1(b.layers.rep + b.layers.width) : sum(bonus),
    cover: Math.round(num(b.cover) ?? 0),
    note: xOnly
      ? "No published work found, so X counts for 80 of 100."
      : b.reason === "path:audits"
        ? "Scored on audit contest results."
        : b.reason === "path:gh_eng+x" || b.reason === "path:gh_eng"
          ? "Scored on GitHub. Audit contests would open the audits path."
          : b.selfAddedLinks
            ? "Work links are added by the person and not checked."
            : null,
    layered,
  };
}

/** «GitHub 74.2, X 46.3 and an onchain bonus»: рядок причин для картинки X. */
export function builtFrom(back: CardBack | null): string | null {
  if (!back) return null;
  if (back.layered) {
    const work = back.lines.filter((l) => l.kind === "core" && l.value !== null).map((l) => `${l.name} ${l.value!.toFixed(1)}`);
    if (work.length === 0) return null;
    const rep = back.lines.some((l) => l.key === "rep" && l.points > 0);
    const more = back.lines.filter((l) => l.kind === "bonus" && l.key !== "rep" && l.points > 0).length;
    const extras = [rep ? "reputation" : null, more ? `${more} more source${more === 1 ? "" : "s"}` : null].filter(Boolean);
    const head = work.length === 1 ? work[0] : `${work.slice(0, -1).join(", ")} and ${work.at(-1)}`;
    return `Built from ${head}${extras.length ? `, plus ${extras.join(" and ")}` : ""}.`;
  }
  const cores = back.lines.filter((l) => l.kind === "core" && l.value !== null).map((l) => `${l.name} ${l.value!.toFixed(1)}`);
  const bonuses = back.lines.filter((l) => l.kind === "bonus" && l.value !== null && l.points > 0).map((l) => l.name.toLowerCase());
  if (cores.length === 0) return null;
  const one = bonuses[0] ?? "";
  const tail =
    bonuses.length > 0 ? ` and ${bonuses.length === 1 ? `${/^[aeiou]/i.test(one) ? "an" : "a"} ${one} bonus` : "bonuses"}` : "";
  const head = cores.length === 1 ? cores[0] : `${cores.slice(0, -1).join(", ")}${tail ? ", " : " and "}${cores.at(-1)}`;
  return `Built from ${head}${tail}.`;
}
