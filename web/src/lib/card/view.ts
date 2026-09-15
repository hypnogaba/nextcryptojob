// Усе, що треба для показу картки, одним об'єктом: його бере і сторінка /c/<slug>,
// і картинки для X, тож вони не розходяться в цифрах, обробці чи печатці.
import type { IdentityKind } from "@/lib/identity/normalize";
import { POSITION_CODE } from "@/lib/roles/recipes";
import { cardBack, type CardBack } from "./back";
import { ROLES, type RoleKey } from "./roles";
import { sealSeed } from "./seal";
import type { PublicCard } from "./store";
import { displayScore, levelRange, MAX_LEVEL, tierFor, type Tier } from "./tiers";

/**
 * Лицьовий бік картки. `kind`:
 * - "real": видана картка (slug є);
 * - "example": приклад на головній, лише з lib/card/example.ts, з позначкою EXAMPLE;
 * - "draft": бал у профілі, картку ще не видано, печатки немає.
 * Позначку EXAMPLE малює лише "example", тож на справжній картці її не буде.
 */
export type CardFace = {
  kind: "real" | "example" | "draft";
  roleName: string;
  positionCode: string;
  score: number;
  level: number;
  tier: Tier;
  displayName: string;
  /** Зерно печатки (FNV-1a) або null, поки картку не видано. Сам гаманець сюди не йде. */
  sealSeed: number | null;
  /** «No. aB3_-x9QzK» або null. */
  number: string | null;
  /** Позначка на лицьовому боці або null. До 13.09 «Wallets not verified» у трейдера; тепер завжди null. */
  marker: string | null;
  /** Одним реченням для alt і aria-label. */
  summary: string;
};

export type CardView = CardFace & {
  slug: string;
  role: RoleKey;
  /** «Level 8 of 10» */
  levelLabel: string;
  /** «70 to 79» */
  levelRange: string;
  formulaVersion: string;
  /** «12 Sep 2026» */
  issuedOn: string;
  /** Розклад балу на звороті або null. */
  back: CardBack | null;
  /** Чому звороту немає (бал змінився після видачі) або null. */
  backMissing: string | null;
  /** Джерела власник вписав сам (модель довіри 13.09): тихий рядок на публічній сторінці. */
  selfReported: boolean;
};

/** Рядок scores власника картки й те, що рахується з його підключень. */
export type CardEvidence = {
  score: number | null;
  breakdownJson: string;
  formulaVersion: string;
  /** Підтверджений гаманець для печатки або null (підпису гаманців у релізі 1 ще немає). */
  wallet: string | null;
  /** Підключення, які рахуються (для причин прогалин). */
  connected: IdentityKind[];
  /** Серед джерел є самозаявлені (людина вписала сама, ніхто не перевіряв). */
  selfReported?: boolean;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** SQLite `YYYY-MM-DD HH:MM:SS` → «12 Sep 2026». Без Intl, щоб не залежати від локалі. */
export function formatIssuedOn(sqlTime: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(sqlTime);
  if (!m) return "";
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

export function summaryOf(f: Pick<CardFace, "displayName" | "roleName" | "score" | "level" | "marker">): string {
  return (
    `${f.displayName}: ${f.roleName}, score ${f.score} of 100, level ${f.level} of ${MAX_LEVEL}` +
    (f.marker ? `. ${f.marker}.` : "")
  );
}

/**
 * Вигляд картки. `evidence` дає зворот і рядок статистики, лише якщо бал людини
 * досі той, з яким картку видали (та сама формула й те саме ціле число):
 * картка знімок, і розклад новішого балу під нею був би неправдою.
 */
export function cardView(card: PublicCard, evidence?: CardEvidence | null): CardView {
  const tier = tierFor(card.level);
  const roleName = ROLES[card.role].name;
  const score = displayScore(card.score);
  // Модель довіри 13.09: позначки «Wallets not verified» більше немає (docs/DECISIONS.md).
  const marker = null;
  const current =
    evidence &&
    evidence.score !== null &&
    evidence.formulaVersion === card.formulaVersion &&
    displayScore(evidence.score) === score;
  const back = current ? cardBack(evidence.breakdownJson, new Set(evidence.connected)) : null;
  const issuedOn = formatIssuedOn(card.createdAt);
  const face: CardFace = {
    kind: "real",
    roleName,
    positionCode: POSITION_CODE[card.role],
    score,
    level: tier.level,
    tier,
    displayName: card.displayName,
    sealSeed: sealSeed({ wallet: evidence?.wallet ?? null, slug: card.slug }),
    number: `No. ${card.slug}`,
    marker,
    summary: "",
  };
  face.summary = summaryOf(face);
  return {
    ...face,
    slug: card.slug,
    role: card.role,
    levelLabel: `Level ${tier.level} of ${MAX_LEVEL}`,
    levelRange: levelRange(tier.level),
    formulaVersion: card.formulaVersion,
    issuedOn,
    back,
    // Без відомостей (картка без рядка людини) теж «self-reported»: інакше тиша читалась би як перевірка.
    selfReported: evidence?.selfReported ?? true,
    backMissing: back
      ? null
      : evidence
        ? `This person's score changed after the card was issued on ${issuedOn}. The card keeps the score it was issued with.`
        : null,
  };
}
