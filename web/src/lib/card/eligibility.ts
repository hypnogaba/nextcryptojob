// Хто може створити картку ролі (рішення controller 12.09, docs/DECISIONS.md):
// лише коли головне джерело ролі підтверджене кодом. Інакше можна поширити
// картку з чужим GitHub чи X. Трейдер може, але картка має позначку, поки
// гаманці нічим підтвердити.
import type { RoleKey } from "./roles";

export type VerifiedSources = { x: boolean; github: boolean };
export type Eligibility = { ok: true; walletsUnverified: boolean } | { ok: false; reason: string };

/** Підпису гаманця ще немає: усі картки трейдера з позначкою. */
const WALLET_SIGNATURES = false;

const NEED_GITHUB = "Verify your GitHub to create this card. The score comes from GitHub, so we need to know it is yours.";
const NEED_X = "Verify your X to create this card. The score comes from X, so we need to know it is yours.";
const NEED_X_NOT_YT =
  "Verify your X to create this card. YouTube verification is coming soon, so a score from YouTube alone cannot get a card yet.";
const NEED_GITHUB_OR_X = "Verify your GitHub or X to create this card, so we know the score is yours.";

const yes = (walletsUnverified = false): Eligibility => ({ ok: true, walletsUnverified });
const no = (reason: string): Eligibility => ({ ok: false, reason });

/** `reason` = breakdown_json.reason ролі (для data_research важливе 'x_only'). */
export function cardEligibility(role: RoleKey, reason: string | null | undefined, v: VerifiedSources): Eligibility {
  switch (role) {
    case "engineer":
    case "security_auditor":
      return v.github ? yes() : no(NEED_GITHUB);
    case "devrel":
      // Шлях GitHub або медійний шлях через X; YouTube підтвердити ще нічим.
      return v.github || v.x ? yes() : no(NEED_GITHUB_OR_X);
    case "bd":
    case "community":
    case "product_manager":
      return v.x ? yes() : no(NEED_X);
    case "marketing_content":
    case "creator_kol":
      return v.x ? yes() : no(NEED_X_NOT_YT);
    case "data_research":
      if (reason === "x_only") return v.x ? yes() : no(NEED_X);
      return v.x || v.github ? yes() : no(NEED_GITHUB_OR_X);
    case "trader":
      return yes(!WALLET_SIGNATURES);
    default:
      return no("This role has no score yet, so it cannot have a card.");
  }
}

/** Позначка на картці (сторінка й картинка для X) або null. */
export function walletMarker(role: RoleKey): string | null {
  return role === "trader" && !WALLET_SIGNATURES ? "Wallets not verified" : null;
}
