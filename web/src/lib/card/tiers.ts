// Рівні картки й кольори десяти ступенів.
//
// Рівень: level = min(10, floor(score/10) + 1) (docs/contracts.md, розділ 4).
// Бал на картці показуємо цілим униз (79.6 → 79), інакше 79.6 виглядав би як
// «80, рівень 8», хоча 80 уже рівень 9.
//
// Контраст (перевіряє tiers.test.ts):
// - `ink` на `base` дає щонайменше 4.5:1: дрібний текст на кольорі ступеня (плашка
//   «Level 8 / 10») стоїть лише на суцільному `base`.
// - `ink` на будь-якій точці фону ступенів 1–9 теж дає 4.5:1. Для 10-го (золото →
//   пурпур) такого кольору немає: темний має 8.9:1 на золоті і 3.6:1 на пурпурі,
//   білий навпаки. Тому на фоні взагалі немає дрібного тексту, а для великих
//   позначок і візерунка на всіх ступенях є щонайменше 3:1.

export type Tier = {
  level: number;
  /** Кольори фону: один (суцільний) або два (градієнт 135°). */
  stops: readonly string[];
  /** Суцільний колір ступеня під дрібним текстом. */
  base: string;
  /** Колір тексту й візерунка на кольорі ступеня. */
  ink: string;
};

const DARK = "#0E1213";
const LIGHT = "#FFFFFF";

export const TIERS: readonly Tier[] = [
  { level: 1, stops: ["#A3ABA9"], base: "#A3ABA9", ink: DARK },
  { level: 2, stops: ["#86A7A0"], base: "#86A7A0", ink: DARK },
  { level: 3, stops: ["#5FA296"], base: "#5FA296", ink: DARK },
  { level: 4, stops: ["#2F9689"], base: "#2F9689", ink: DARK },
  { level: 5, stops: ["#2A8AA0"], base: "#2A8AA0", ink: DARK },
  { level: 6, stops: ["#3A74B8"], base: "#3A74B8", ink: LIGHT },
  { level: 7, stops: ["#5A5FC4"], base: "#5A5FC4", ink: LIGHT },
  { level: 8, stops: ["#7B4FC0", "#3A74B8"], base: "#7B4FC0", ink: LIGHT },
  { level: 9, stops: ["#A8479E", "#5A5FC4"], base: "#A8479E", ink: LIGHT },
  { level: 10, stops: ["#E0A93A", "#A8479E"], base: "#E0A93A", ink: DARK },
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

/** Стиль фону для React і для next/og (Satori розуміє ці ж властивості). */
export function tierBackground(tier: Tier): { backgroundColor: string; backgroundImage?: string } {
  const [from, to] = tier.stops;
  return to
    ? { backgroundColor: from, backgroundImage: `linear-gradient(135deg, ${from}, ${to})` }
    : { backgroundColor: from };
}
