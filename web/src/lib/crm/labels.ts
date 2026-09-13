import { ROLES, isRoleKey } from "@/lib/card/roles";
import type { Badges, CandidateSummary, Chain, EmptyReason, RoleKey, RoleScore, Stage, UnscoredReason } from "./types";

/**
 * Тексти інтерфейсу CRM для полів анонімного профілю (специфікація 5.2, 5.3,
 * 5.4, 10.2). Лише з полів білого списку: жодних нових даних про людину.
 * Англійською, без довгого тире.
 */

export const STAGE_ORDER: readonly Stage[] = ["found", "intro_requested", "contact_shared", "interview", "hired", "declined"];

export const STAGE_TEXT: Record<Stage, string> = {
  found: "Found",
  intro_requested: "Intro requested",
  contact_shared: "Contact shared",
  interview: "Interview",
  hired: "Hired",
  declined: "Declined",
};

export const CHAIN_TEXT: Record<Chain, string> = {
  ethereum: "Ethereum",
  base: "Base",
  arbitrum: "Arbitrum",
  optimism: "Optimism",
  solana: "Solana",
  hyperliquid: "Hyperliquid",
};

export function roleText(role: string | null | undefined): string {
  return role && isRoleKey(role) ? ROLES[role].name : "Unknown role";
}

/** Головне джерело ролі словами (contracts §4, «Головні»): для "Not scored: needs …". */
const ANCHOR_TEXT: Partial<Record<RoleKey, string>> = {
  engineer: "GitHub",
  security_auditor: "GitHub or Sherlock",
  devrel: "X, YouTube or GitHub",
  data_research: "a site, GitHub or X",
  product_manager: "X",
  bd: "X",
  marketing_content: "X or YouTube",
  creator_kol: "X or YouTube",
  community: "X",
  trader: "a wallet",
};

/** Чому роль без балу (5.3). */
export function unscoredText(role: RoleKey, reason: UnscoredReason | null): string {
  switch (reason) {
    case "missing_anchor":
      return `Not scored: needs ${ANCHOR_TEXT[role] ?? "more sources"}`;
    case "needs_cv":
      return "Not scored yet: needs a CV";
    case "needs_portfolio":
      return "Not scored yet: needs a portfolio";
    case "not_published":
      return "Scores are not published yet";
    case "pending":
    case null:
      return "Score is being calculated";
  }
}

/** "Engineer 81" або "Engineer, not scored". */
export function roleScoreText(r: RoleScore): string {
  return r.score === null ? `${roleText(r.role)}, not scored` : `${roleText(r.role)} ${r.score}`;
}

export function onchainYearsText(years: CandidateSummary["onchain_years"]): string | null {
  if (years === null) return null;
  if (years === 0) return "Less than 1 year onchain";
  if (years === 1) return "1+ year onchain";
  return `${years}+ years onchain`;
}

const NUMBER = new Intl.NumberFormat("en-US");

export function salaryText(floor: CandidateSummary["salary_floor"]): string | null {
  return floor ? `From ${NUMBER.format(floor.amount)} ${floor.currency}` : null;
}

export function workText(work: CandidateSummary["work"]): string {
  const parts: string[] = [];
  if (work.modes.includes("remote")) parts.push("Remote");
  if (work.modes.includes("city")) parts.push(work.city ?? "On site");
  return parts.length ? parts.join(" or ") : "Work mode not set";
}

export function badgeTexts(b: Badges): string[] {
  const out: string[] = [];
  if (b.x_verified) out.push("X verified");
  if (b.wallet === "signature_verified") out.push("Wallet verified by signature");
  if (b.wallet === "not_signature_verified") out.push("Wallet not signature-verified");
  if (b.github_linked) out.push("GitHub linked");
  if (b.youtube_linked) out.push("YouTube linked");
  if (b.site_linked) out.push("Site linked");
  return out;
}

export function contactModeText(mode: "approval" | "direct"): string {
  return mode === "direct" ? "Telegram handle available" : "Contact after approval";
}

/** Порожній пошук завжди називає причину (5.2). */
export function emptyReasonText(reason: EmptyReason, visibleCount: number | null | undefined): string {
  switch (reason) {
    case "scores_not_published":
      return "Scores are not published yet. We publish them once the formula passes our quality check.";
    case "no_visible_candidates_for_role":
      return "No visible candidates chose this role yet. Save the search and we will email you when someone does.";
    case "filters_too_narrow":
      return `No candidates match all filters. ${visibleCount ?? 0} visible ${visibleCount === 1 ? "candidate" : "candidates"} chose this role.`;
  }
}

const DAY_MS = 86_400_000;

/** "Expires in 5 days" / "Expires today" для знайомства, що чекає. */
export function expiresInText(expiresAtIso: string, now: Date): string {
  const days = Math.ceil((new Date(expiresAtIso).getTime() - now.getTime()) / DAY_MS);
  if (days <= 0) return "Expires today";
  if (days === 1) return "Expires in 1 day";
  return `Expires in ${days} days`;
}

export const INTRO_STATUS_TEXT: Record<string, string> = {
  pending: "Waiting for answer",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
  canceled: "Withdrawn",
  direct: "Handle viewed",
};
