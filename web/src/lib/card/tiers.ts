// Рівні картки: обробка картки (finish) і щільність печатки замість кольорів.
//
// Рівень: level = min(10, floor(score/10) + 1) (docs/contracts.md, розділ 4).
// Бал на картці показуємо цілим униз (79.6 → 79), інакше 79.6 виглядав би як
// «80, рівень 8», хоча 80 уже рівень 9.
//
// Рівень читається матеріалом, а не відтінком (дослідження дизайну 12.09), окрім Mint
// і Lavender (раунд 4, макет round4/dir-6): п'ять обробок картки банківського формату
// (1.586):
// - 1 to 3 Paper: світла картка, чорнильна печатка;
// - 4 and 5 Mint: м'ятна картка, зелена печатка;
// - 6 and 7 Lavender: лавандова картка, фіолетова печатка;
// - 8 and 9 Chrome: сріблястий відблиск без відтінку;
// - 10 Black: чорна картка, печатка м'ятою й лавандою.
// Печатка має стільки шарів, скільки рівень (lib/card/seal.ts).
//
// Фарби не залежать від теми сайту: картка друкований предмет, і та сама
// картка йде в картинку для X. Контраст перевіряє tiers.test.ts.

export type Finish = "paper" | "mint" | "lavender" | "chrome" | "black";

export type Tier = {
  level: number;
  finish: Finish;
  /** «Paper», «Mint», «Lavender», «Chrome», «Black». */
  finishName: string;
  /** Шари печатки = рівень. */
  sealLayers: number;
  /** Суцільний колір рамки (під відблиском і там, де градієнта немає). */
  frame: string;
  /** Відблиск рамки (135°) або null. */
  sheen: readonly string[] | null;
  /** Текст на рамці (рядок сезону й номера); тепер той самий, що ink. */
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

const INK = "#0e0f12";
const PAPER_WINDOW = "#f7f8fa";
const BLACK_WINDOW = "#0e0f12";
const LIGHT = "#f2f3f5";

/** Печатка десятого рівня (Black): м'ята й лаванда, кольори двох обробок нижче. */
export const MINT_ACCENT = "#a7ead0";
export const LAVENDER_ACCENT = "#c9b8f5";
/** Стара назва лишилась сумісною (єдиний колір сайту до раунду 4). */
export const SEAL_ACCENT = MINT_ACCENT;

const paper = (level: number): Tier => ({
  level,
  finish: "paper",
  finishName: "Paper",
  sealLayers: level,
  frame: "#eceef1",
  sheen: ["#fdfdfd", "#eceef1", "#f7f8fa", "#e3e5e9"],
  frameInk: INK,
  window: PAPER_WINDOW,
  ink: INK,
  ink2: "#5d616b",
  hairline: "#d6d9df",
  sealInks: [INK, "#7b808a"],
});

const mint = (level: number): Tier => ({
  level,
  finish: "mint",
  finishName: "Mint",
  sealLayers: level,
  frame: "#bfeedb",
  sheen: ["#effbf6", "#bfeedb", "#dcf6eb", "#9fdfc4"],
  frameInk: "#0b3a2b",
  window: "#eafbf3",
  ink: "#0b3a2b",
  ink2: "#0f5a41",
  hairline: "#8fd4b3",
  sealInks: ["#0b5a41", "#35a57d"],
});

const lavender = (level: number): Tier => ({
  level,
  finish: "lavender",
  finishName: "Lavender",
  sealLayers: level,
  frame: "#d9ccf7",
  sheen: ["#f6f2ff", "#d9ccf7", "#ece5fc", "#c0adf0"],
  frameInk: "#2a1d5c",
  window: "#f3effc",
  ink: "#2a1d5c",
  ink2: "#3d2a8c",
  hairline: "#b7a3ec",
  sealInks: ["#3d2a8c", "#8a6fe0"],
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
  sealInks: [MINT_ACCENT, LAVENDER_ACCENT],
});

export const TIERS: readonly Tier[] = [
  paper(1), paper(2), paper(3),
  mint(4), mint(5),
  lavender(6), lavender(7),
  chrome(8), chrome(9),
  black(10),
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

/** П'ять обробок драбини рівнів: назва, рівні, приклад рівня. */
export const FINISHES: readonly { finish: Finish; name: string; levels: string; sample: number }[] = [
  { finish: "paper", name: "Paper", levels: "Levels 1 to 3", sample: 3 },
  { finish: "mint", name: "Mint", levels: "Levels 4 and 5", sample: 5 },
  { finish: "lavender", name: "Lavender", levels: "Levels 6 and 7", sample: 7 },
  { finish: "chrome", name: "Chrome", levels: "Levels 8 and 9", sample: 9 },
  { finish: "black", name: "Black", levels: "Level 10", sample: 10 },
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
