// Рівні картки: обробка картки (finish) і щільність печатки замість кольорів.
//
// Рівень: level = min(10, floor(score/10) + 1) (docs/contracts.md, розділ 4).
// Бал на картці показуємо цілим униз (79.6 → 79), інакше 79.6 виглядав би як
// «80, рівень 8», хоча 80 уже рівень 9.
//
// Рівень читається матеріалом, а не відтінком (дослідження дизайну 12.09); з раунду 3
// картка має формат банківської (1.586), а рівень показує кругла печатка-жетон:
// - 1 to 4 Paper: світла картка, чорнильна печатка;
// - 5 to 7 Chrome: сріблястий відблиск без відтінку;
// - 8 and 9 Black: чорна картка, світла печатка;
// - 10 Gold seal: чорна картка, печатка лимонним, єдиним кольором сайту.
// Печатка має стільки шарів, скільки рівень (lib/card/seal.ts).
//
// Фарби не залежать від теми сайту: картка друкований предмет, і та сама
// картка йде в картинку для X. Контраст перевіряє tiers.test.ts.

export type Finish = "paper" | "chrome" | "black" | "red_seal";

export type Tier = {
  level: number;
  finish: Finish;
  /** «Paper», «Chrome», «Black», «Gold seal». Ключ "red_seal" лишився від першої версії. */
  finishName: string;
  /** Шари печатки = рівень. */
  sealLayers: number;
  /** Суцільний колір рамки (під відблиском і там, де градієнта немає). */
  frame: string;
  /** Відблиск рамки (135°) або null. */
  sheen: readonly string[] | null;
  /** Текст на рамці (рядок сезону й номера). */
  frameInk: string;
  /** Друковане поле всередині рамки. */
  window: string;
  /** Текст на полі. */
  ink: string;
  /** Другорядний текст на полі. */
  ink2: string;
  /** Тонкі лінії на полі. */
  hairline: string;
  /** Фарби шарів печатки, по черзі. */
  sealInks: readonly [string, string];
};

const INK = "#111318";
const PAPER_WINDOW = "#f7f8fa";
const BLACK_WINDOW = "#15171c";
const LIGHT = "#f3f4f6";

const paper = (level: number): Tier => ({
  level,
  finish: "paper",
  finishName: "Paper",
  sealLayers: level,
  frame: "#eceef1",
  sheen: ["#f7f8fa", "#e6e8ec", "#f3f4f6", "#dfe2e7"],
  frameInk: INK,
  window: PAPER_WINDOW,
  ink: INK,
  ink2: "#5a5f6b",
  hairline: "#d6d9df",
  sealInks: [INK, "#7b808a"],
});

const chrome = (level: number): Tier => ({
  ...paper(level),
  finish: "chrome",
  finishName: "Chrome",
  frame: "#d0d3d7",
  sheen: ["#f4f5f6", "#c3c6cb", "#eceef0", "#b6babf"],
  ink2: "#3b3f47",
  hairline: "#b3b7bd",
});

const black = (level: number): Tier => ({
  level,
  finish: "black",
  finishName: "Black",
  sealLayers: level,
  frame: "#15171c",
  sheen: ["#2a2e37", "#15171c", "#1d2027", "#101216"],
  frameInk: LIGHT,
  window: BLACK_WINDOW,
  ink: LIGHT,
  ink2: "#a9aeb8",
  hairline: "#2c3039",
  sealInks: ["#e9ebee", "#8f949c"],
});

/** Єдиний колір сайту (лимонний): печатка десятого рівня. */
export const SEAL_ACCENT = "#ffdb2e";

const goldSeal = (level: number): Tier => ({
  ...black(level),
  finish: "red_seal",
  finishName: "Gold seal",
  sealInks: [SEAL_ACCENT, "#b89a14"],
});

export const TIERS: readonly Tier[] = [
  paper(1), paper(2), paper(3), paper(4),
  chrome(5), chrome(6), chrome(7),
  black(8), black(9),
  goldSeal(10),
];

export const MAX_LEVEL = 10;

function clampScore(score: number): number {
  if (!Number.isFinite(score)) throw new RangeError(`score must be a finite number, got ${score}`);
  return Math.min(100, Math.max(0, score));
}

export function levelFor(score: number): number {
  return Math.min(MAX_LEVEL, Math.floor(clampScore(score) / 10) + 1);
}

/** Бал для показу: ціле число, яке не суперечить рівню. */
export function displayScore(score: number): number {
  return Math.floor(clampScore(score));
}

/** Межі балу рівня словами: «70 to 79», для 10-го «90 to 100». */
export function levelRange(level: number): string {
  const from = (level - 1) * 10;
  return level >= MAX_LEVEL ? `${from} to 100` : `${from} to ${from + 9}`;
}

export function tierFor(level: number): Tier {
  if (!Number.isFinite(level)) throw new RangeError(`level must be a finite number, got ${level}`);
  return TIERS[Math.min(MAX_LEVEL, Math.max(1, Math.trunc(level))) - 1];
}

/** Чотири обробки драбини рівнів: назва, рівні, приклад рівня. */
export const FINISHES: readonly { finish: Finish; name: string; levels: string; sample: number }[] = [
  { finish: "paper", name: "Paper", levels: "Levels 1 to 4", sample: 4 },
  { finish: "chrome", name: "Chrome", levels: "Levels 5 to 7", sample: 7 },
  { finish: "black", name: "Black", levels: "Levels 8 and 9", sample: 9 },
  { finish: "red_seal", name: "Gold seal", levels: "Level 10", sample: 10 },
];

/** Тло рамки для React і для next/og (Satori розуміє ці ж властивості). */
export function tierBackground(tier: Tier): { backgroundColor: string; backgroundImage?: string } {
  if (!tier.sheen) return { backgroundColor: tier.frame };
  const [a, b, c, d] = tier.sheen;
  return {
    backgroundColor: tier.frame,
    backgroundImage: `linear-gradient(135deg, ${a} 0%, ${b} 42%, ${c} 55%, ${d} 100%)`,
  };
}

/** CSS-змінні картки (globals.css, .ncj-face). */
export function tierVars(tier: Tier): Record<string, string> {
  const bg = tierBackground(tier);
  return {
    "--card-frame": tier.frame,
    "--card-frame-solid": tier.frame,
    "--card-sheen": bg.backgroundImage ?? "none",
    "--card-frame-ink": tier.frameInk,
    "--card-window": tier.window,
    "--card-ink": tier.ink,
    "--card-ink-2": tier.ink2,
    "--card-hairline": tier.hairline,
  };
}
