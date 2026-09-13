// Рівні картки: обробка картки (finish) і щільність печатки замість кольорів.
//
// Рівень: level = min(10, floor(score/10) + 1) (docs/contracts.md, розділ 4).
// Бал на картці показуємо цілим униз (79.6 → 79), інакше 79.6 виглядав би як
// «80, рівень 8», хоча 80 уже рівень 9.
//
// Рівень читається матеріалом, а не відтінком (дослідження дизайну 12.09):
// - 1–4 Paper: сірий картон, чорнильна печатка;
// - 5–7 Chrome: нейтральний сірий відблиск без відтінку;
// - 8–9 Black: чорна картка, світла печатка;
// - 10 Red seal: чорна картка, печатка єдиним акцентом.
// Печатка має стільки шарів, скільки рівень (lib/card/seal.ts).
//
// Фарби не залежать від теми сайту: картка друкований предмет, і та сама
// картка йде в картинку для X. Контраст перевіряє tiers.test.ts.

export type Finish = "paper" | "chrome" | "black" | "red_seal";

export type Tier = {
  level: number;
  finish: Finish;
  /** «Paper», «Chrome», «Black», «Red seal». */
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

const INK = "#121418";
const PAPER_WINDOW = "#fbfbfa";
const BLACK_WINDOW = "#151619";
const LIGHT = "#eceef1";

const paper = (level: number): Tier => ({
  level,
  finish: "paper",
  finishName: "Paper",
  sealLayers: level,
  frame: "#dcdedf",
  sheen: null,
  frameInk: INK,
  window: PAPER_WINDOW,
  ink: INK,
  ink2: "#5d6166",
  hairline: "#cfd2d6",
  sealInks: [INK, "#82868b"],
});

const chrome = (level: number): Tier => ({
  ...paper(level),
  finish: "chrome",
  finishName: "Chrome",
  frame: "#bdbdbd",
  sheen: ["#f4f4f4", "#a9a9a9", "#eeeeee", "#8f8f8f"],
});

const black = (level: number): Tier => ({
  level,
  finish: "black",
  finishName: "Black",
  sealLayers: level,
  frame: "#0c0d0f",
  sheen: ["#2a2c30", "#0e0f11", "#33363b", "#08090a"],
  frameInk: LIGHT,
  window: BLACK_WINDOW,
  ink: LIGHT,
  ink2: "#a9adb2",
  hairline: "#2e3136",
  sealInks: ["#e9ebee", "#90949a"],
});

/** Єдиний акцент сайту в темному варіанті: на чорному він читається краще. */
export const SEAL_ACCENT = "#ff7a4d";

const redSeal = (level: number): Tier => ({
  ...black(level),
  finish: "red_seal",
  finishName: "Red seal",
  sealInks: [SEAL_ACCENT, "#c9603e"],
});

export const TIERS: readonly Tier[] = [
  paper(1), paper(2), paper(3), paper(4),
  chrome(5), chrome(6), chrome(7),
  black(8), black(9),
  redSeal(10),
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
  { finish: "red_seal", name: "Red seal", levels: "Level 10", sample: 10 },
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
