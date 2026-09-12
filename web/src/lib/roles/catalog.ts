// Ролі для вибору в анкеті (docs/contracts.md, §1): порядок, які рахуються зараз,
// і чого бракує решті. Назви ролей живуть у card/roles.ts, тут лише те, що
// потрібно анкеті й сторінці балу.
import { isRoleKey, ROLES, type RoleKey } from "@/lib/card/roles";

/** Порядок як у договорі §1: спершу ті, що рахуються. */
export const ROLE_ORDER = Object.keys(ROLES) as RoleKey[];

export type UnscoredReason = "needs_cv" | "needs_portfolio";

/** Ролі, яких публічні джерела не доводять: у релізі 1 без балу. */
export const UNSCORED: Partial<Record<RoleKey, UnscoredReason>> = {
  designer: "needs_portfolio",
  operations_support: "needs_cv",
  finance: "needs_cv",
  legal_compliance: "needs_cv",
  hr_recruiting: "needs_cv",
};

export const MAX_ROLES = 3;

export function isScoredRole(role: RoleKey): boolean {
  return UNSCORED[role] === undefined;
}

/** Пояснення для ролі без балу або null. */
export function unscoredNote(role: RoleKey): string | null {
  const reason = UNSCORED[role];
  if (reason === "needs_portfolio") return "Score needs a portfolio, coming soon";
  if (reason === "needs_cv") return "Score needs a CV, coming soon";
  return null;
}

/** Ролі з JSON у users.roles: лише відомі ключі, без повторів, у порядку людини. */
export function parseRoles(json: string | null | undefined): RoleKey[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: RoleKey[] = [];
  for (const v of raw) {
    if (typeof v === "string" && isRoleKey(v) && !out.includes(v)) out.push(v);
  }
  return out;
}
