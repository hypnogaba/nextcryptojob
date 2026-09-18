// Рецепти ролей формули v7 (власник 17.09.2026) для показу: код позиції на картці і «Робота» кожної
// ролі в балах (разом WORK_POINTS). Репутація й ширина однакові для всіх ролей. Числа ті самі, що в
// engine/src/formula/v7.ts; тест recipes.test.ts звіряє їх з рушієм.
import type { RoleKey } from "@/lib/card/roles";

export type SourceKey =
  | "gh_eng" | "gh_builder" | "x" | "yt" | "media" | "output" | "onchain" | "trading" | "site" | "audits" | "dune"
  | "links" | "rep" | "best";

/** Коротка назва джерела на картці й у рецепті. */
export const SOURCE_NAME: Record<SourceKey, string> = {
  gh_eng: "GitHub",
  gh_builder: "GitHub projects",
  x: "X",
  yt: "YouTube",
  media: "Media",
  output: "Published work",
  onchain: "Onchain",
  trading: "Trading",
  site: "Website",
  audits: "Audit contests",
  dune: "Dune",
  links: "Work links",
  rep: "Reputation",
  best: "Strongest source",
};

/** Код джерела в рядку статистики на лицьовому боці. */
export const SOURCE_CODE: Record<SourceKey, string> = {
  gh_eng: "GH",
  gh_builder: "BLD",
  x: "X",
  yt: "YT",
  media: "MED",
  output: "OUT",
  onchain: "ONC",
  trading: "TRD",
  site: "WEB",
  audits: "AUD",
  dune: "DUN",
  links: "LNK",
  rep: "REP",
  best: "TOP",
};

export function isSourceKey(key: string): key is SourceKey {
  return Object.hasOwn(SOURCE_NAME, key);
}

/** Код позиції на картці, як у спортивних картках. */
export const POSITION_CODE: Record<RoleKey, string> = {
  engineer: "ENG",
  security_auditor: "SEC",
  devrel: "DRL",
  data_research: "DAT",
  product_manager: "PM",
  bd: "BD",
  marketing_content: "MKT",
  creator_kol: "KOL",
  community: "COM",
  trader: "TRD",
  designer: "DSN",
  operations_support: "OPS",
  finance: "FIN",
  legal_compliance: "LGL",
  hr_recruiting: "HR",
};

type Weights = readonly (readonly [SourceKey, number])[];
export type Recipe = { paths: readonly Weights[] };

/** Шари v8 (engine/src/formula/v7.ts): ширина рахує кожне інше джерело, по WIDTH_EACH, разом до WIDTH_MAX. */
export const WORK_POINTS = 60;
export const REP_POINTS = 25;
export const WIDTH_EACH = 5;
export const WIDTH_MAX = 20;

/** Бал з шарами «робота + репутація + ширина»: v7 і новіші (v8 змінила ширину, v9 репутацію). */
export const isLayeredFormula = (formula: string | null | undefined): boolean => {
  const n = /^v(\d+)$/.exec(formula ?? "")?.[1];
  return n !== undefined && Number(n) >= 7;
};

const GENERAL: Recipe = { paths: [[["best", 40], ["links", 20]]] };

/** Усі 15 ролей рахуються з v7/v8. Вага = бали «Роботи». */
export const RECIPES = {
  engineer: { paths: [[["gh_eng", 40], ["gh_builder", 20]]] },
  security_auditor: { paths: [[["audits", 30], ["gh_eng", 30]], [["gh_eng", 60]]] },
  devrel: { paths: [[["media", 30], ["gh_eng", 30]]] },
  data_research: { paths: [[["output", 30], ["x", 30]]] },
  product_manager: { paths: [[["x", 20], ["gh_builder", 20], ["output", 20]]] },
  bd: { paths: [[["x", 50], ["onchain", 10]]] },
  marketing_content: { paths: [[["media", 40], ["site", 20]]] },
  creator_kol: { paths: [[["media", 60]]] },
  community: { paths: [[["x", 50], ["onchain", 10]]] },
  trader: { paths: [[["trading", 50], ["onchain", 10]]] },
  designer: { paths: [[["links", 40], ["x", 20]]] },
  operations_support: GENERAL,
  finance: GENERAL,
  legal_compliance: GENERAL,
  hr_recruiting: GENERAL,
} as const satisfies Record<RoleKey, Recipe>;

export type ScoredRoleKey = keyof typeof RECIPES;
export const SCORED_ROLE_KEYS = Object.keys(RECIPES) as ScoredRoleKey[];

export function isScoredRoleKey(role: string): role is ScoredRoleKey {
  return Object.hasOwn(RECIPES, role);
}

const list = (w: Weights) => w.map(([k, n]) => `${SOURCE_NAME[k]} ${n}`).join(", ");

/** «GitHub 40, GitHub projects 20» або «Audit contests 30, GitHub 30, or GitHub 60». */
export function recipeCore(role: ScoredRoleKey): string {
  return RECIPES[role].paths.map(list).join(", or ");
}

/** Те, що однаково для всіх ролей: репутація й ширина. */
export function recipeBonus(_role?: ScoredRoleKey): string {
  return `Reputation up to ${REP_POINTS}, and every other source you connect up to ${WIDTH_EACH} each (${WIDTH_MAX} in total)`;
}
