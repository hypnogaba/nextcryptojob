// Таблиця ролей формули v6 (docs/contracts.md §1, §4).
import type { RoleKey } from "../types.js";
import type { ScoreSource } from "./sources.js";

type Weights = Partial<Record<ScoreSource, number>>;

/** Шлях доказів: ядро з вагами (Σ = 100) і мітка для `breakdown_json.reason = 'path:<мітка>'`. */
export type CorePath = { label: string; core: Weights };

export type ScoredRole = {
  /** Один шлях або кілька (береться сильніший; за рівності перший). */
  paths: readonly [CorePath, ...CorePath[]];
  /** Додатки: максимум балів, лише додають. */
  bonus: Weights;
  /** Головні джерела: потрібне хоч одне не-null і не 0. */
  anchors: readonly ScoreSource[];
  /** v5, дані й дослідження: без output ядро = factor · x, reason = 'x_only'. */
  xOnlyFactor?: number;
};

export type UnscoredReason = "needs_cv" | "needs_portfolio";
export type ScoredRoleKey = Exclude<RoleKey, "designer" | "operations_support" | "finance" | "legal_compliance" | "hr_recruiting">;
type UnscoredRoleKey = Exclude<RoleKey, ScoredRoleKey>;

const one = (core: Weights): readonly [CorePath] => [{ label: Object.keys(core).join("+"), core }];

export const SCORED_ROLES: Record<ScoredRoleKey, ScoredRole> = {
  engineer: { paths: one({ gh_eng: 80, x: 20 }), bonus: { onchain: 5, site: 5 }, anchors: ["gh_eng"] },
  security_auditor: {
    paths: [{ label: "audits", core: { audits: 60, gh_eng: 25, x: 15 } }, { label: "gh_eng+x", core: { gh_eng: 70, x: 30 } }],
    bonus: { site: 5, onchain: 5 }, anchors: ["audits", "gh_eng"],
  },
  devrel: { paths: one({ media: 50, gh_eng: 50 }), bonus: { site: 5, onchain: 5 }, anchors: ["media", "gh_eng"] },
  data_research: {
    paths: one({ output: 50, x: 50 }), bonus: { onchain: 5, gh_builder: 5 }, anchors: ["output", "x"], xOnlyFactor: 0.8,
  },
  product_manager: { paths: one({ x: 50, gh_builder: 25, site: 25 }), bonus: { onchain: 5, gh_eng: 5 }, anchors: ["x"] },
  bd: { paths: one({ x: 100 }), bonus: { onchain: 5, site: 5 }, anchors: ["x"] },
  marketing_content: { paths: one({ media: 100 }), bonus: { site: 7, onchain: 3 }, anchors: ["media"] },
  creator_kol: { paths: one({ media: 100 }), bonus: { onchain: 5, site: 5 }, anchors: ["media"] },
  community: { paths: one({ x: 100 }), bonus: { onchain: 7, site: 3 }, anchors: ["x"] },
  trader: { paths: one({ trading: 90, onchain: 10 }), bonus: { x: 5, site: 5 }, anchors: ["trading"] },
};

/** Ролі, яких публічні джерела не доводять: реліз 1 просить CV або портфоліо. */
export const UNSCORED_ROLES: Record<UnscoredRoleKey, UnscoredReason> = {
  designer: "needs_portfolio",
  operations_support: "needs_cv",
  finance: "needs_cv",
  legal_compliance: "needs_cv",
  hr_recruiting: "needs_cv",
};

/** Порядок ролей як у договорі §1. */
export const ROLE_ORDER: readonly RoleKey[] = ["engineer", "security_auditor", "devrel", "data_research", "product_manager",
  "bd", "marketing_content", "creator_kol", "community", "trader", "designer", "operations_support", "finance",
  "legal_compliance", "hr_recruiting"];
