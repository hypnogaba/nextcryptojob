// Рецепти ролей формули v5 (docs/contracts.md, §4) для показу: код позиції на
// картці, ядро з вагами й додатки. Числа ті самі, що в engine/src/formula/roles.ts;
// якщо договір зміниться, міняти обидва місця (тест recipes.test.ts тримає суми).
import type { RoleKey } from "@/lib/card/roles";

export type SourceKey = "gh_eng" | "gh_builder" | "x" | "yt" | "media" | "output" | "onchain" | "trading" | "site" | "audits" | "dune";

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
export type Recipe = { paths: readonly Weights[]; bonus: Weights };

/** Десять ролей, які рахуються в релізі 1, у порядку договору. */
export const RECIPES = {
  engineer: { paths: [[["gh_eng", 80], ["x", 20]]], bonus: [["onchain", 5], ["site", 5]] },
  security_auditor: {
    paths: [
      [["audits", 60], ["gh_eng", 25], ["x", 15]],
      [["gh_eng", 70], ["x", 30]],
    ],
    bonus: [["site", 5], ["onchain", 5]],
  },
  devrel: { paths: [[["media", 50], ["gh_eng", 50]]], bonus: [["site", 5], ["onchain", 5]] },
  data_research: { paths: [[["output", 50], ["x", 50]]], bonus: [["onchain", 5], ["gh_builder", 5]] },
  product_manager: { paths: [[["x", 50], ["gh_builder", 25], ["site", 25]]], bonus: [["onchain", 5], ["gh_eng", 5]] },
  bd: { paths: [[["x", 100]]], bonus: [["onchain", 5], ["site", 5]] },
  marketing_content: { paths: [[["media", 100]]], bonus: [["site", 7], ["onchain", 3]] },
  creator_kol: { paths: [[["media", 100]]], bonus: [["onchain", 5], ["site", 5]] },
  community: { paths: [[["x", 100]]], bonus: [["onchain", 7], ["site", 3]] },
  trader: { paths: [[["trading", 80], ["onchain", 20]]], bonus: [["x", 5], ["site", 5]] },
} as const satisfies Partial<Record<RoleKey, Recipe>>;

export type ScoredRoleKey = keyof typeof RECIPES;
export const SCORED_ROLE_KEYS = Object.keys(RECIPES) as ScoredRoleKey[];

const list = (w: Weights) => w.map(([k, n]) => `${SOURCE_NAME[k]} ${n}`).join(", ");

/** «GitHub 80, X 20» або «Audit contests 60, GitHub 25, X 15, or GitHub 70, X 30». */
export function recipeCore(role: ScoredRoleKey): string {
  return RECIPES[role].paths.map(list).join(", or ");
}

/** «Onchain up to 5, Website up to 5». */
export function recipeBonus(role: ScoredRoleKey): string {
  return RECIPES[role].bonus.map(([k, n]) => `${SOURCE_NAME[k]} up to ${n}`).join(", ");
}
