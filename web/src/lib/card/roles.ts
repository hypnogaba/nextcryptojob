// Ролі з docs/contracts.md, розділ 1: ключ → назва в інтерфейсі.
// `as` дає фразу для допису в X: «I scored 72 as a Security auditor».
// Назви на кшталт «Data & research» не є професією, тому для них «in».
export const ROLES = {
  engineer: { name: "Engineer", as: "as an Engineer" },
  security_auditor: { name: "Security auditor", as: "as a Security auditor" },
  devrel: { name: "DevRel", as: "in DevRel" },
  data_research: { name: "Data & research", as: "in Data & research" },
  product_manager: { name: "Product / project manager", as: "as a Product / project manager" },
  bd: { name: "BD & partnerships", as: "in BD & partnerships" },
  marketing_content: { name: "Marketing & content", as: "in Marketing & content" },
  creator_kol: { name: "Creator / KOL", as: "as a Creator / KOL" },
  community: { name: "Community", as: "in Community" },
  trader: { name: "Trader", as: "as a Trader" },
  designer: { name: "Designer", as: "as a Designer" },
  operations_support: { name: "Operations & support", as: "in Operations & support" },
  finance: { name: "Finance", as: "in Finance" },
  legal_compliance: { name: "Legal & compliance", as: "in Legal & compliance" },
  hr_recruiting: { name: "HR & recruiting", as: "in HR & recruiting" },
} as const;

export type RoleKey = keyof typeof ROLES;

export function isRoleKey(value: string): value is RoleKey {
  return Object.hasOwn(ROLES, value);
}
