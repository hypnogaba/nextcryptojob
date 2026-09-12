// Усе, що треба для показу картки, одним об'єктом: його бере і сторінка /c/<slug>,
// і картинка для X, тож вони не розходяться в цифрах, кольорах чи візерунку.
import { makePattern, patternDataUri, patternSeed } from "./pattern";
import { ROLES } from "./roles";
import type { PublicCard } from "./store";
import { displayScore, levelRange, MAX_LEVEL, tierBackground, tierFor, type Tier } from "./tiers";

/** Прозорість ліній візерунка на кольорі ступеня. */
export const PATTERN_OPACITY = 0.3;

export type CardView = {
  slug: string;
  roleName: string;
  score: number;
  level: number;
  /** «Level 8 / 10» */
  levelLabel: string;
  /** «70 to 79» */
  levelRange: string;
  displayName: string;
  tier: Tier;
  background: ReturnType<typeof tierBackground>;
  /** data:image/svg+xml;base64,… */
  patternSrc: string;
  formulaVersion: string;
  /** «12 Sep 2026» */
  issuedOn: string;
  /** Одним реченням для alt і aria-label. */
  summary: string;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** SQLite `YYYY-MM-DD HH:MM:SS` → «12 Sep 2026». Без Intl, щоб не залежати від локалі. */
export function formatIssuedOn(sqlTime: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(sqlTime);
  if (!m) return "";
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

export function cardView(card: PublicCard): CardView {
  const tier = tierFor(card.level);
  const roleName = ROLES[card.role].name;
  const score = displayScore(card.score);
  return {
    slug: card.slug,
    roleName,
    score,
    level: tier.level,
    levelLabel: `Level ${tier.level} / ${MAX_LEVEL}`,
    levelRange: levelRange(tier.level),
    displayName: card.displayName,
    tier,
    background: tierBackground(tier),
    patternSrc: patternDataUri(makePattern(patternSeed(card.displayName, card.role)), tier.ink, PATTERN_OPACITY),
    formulaVersion: card.formulaVersion,
    issuedOn: formatIssuedOn(card.createdAt),
    summary: `${card.displayName}: ${roleName}, score ${score} of 100, level ${tier.level} of ${MAX_LEVEL}`,
  };
}
