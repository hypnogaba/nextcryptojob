import { describe, expect, it } from "vitest";
import { displayScore, levelFor, levelRange, tierBackground, tierFor, TIERS } from "./tiers";

// WCAG 2.x: відносна яскравість і контраст.
function rgb(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}
function luminance([r, g, b]: number[]): number {
  const [R, G, B] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}
function contrast(a: number[], b: number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** Точки фону: кожен колір градієнта з кроком 1% (браузер і Satori змішують в sRGB). */
function backgroundSamples(stops: readonly string[]): number[][] {
  if (stops.length === 1) return [rgb(stops[0])];
  const [a, b] = stops.map(rgb);
  return Array.from({ length: 101 }, (_, i) => a.map((v, k) => v + ((b[k] - v) * i) / 100));
}
const minContrast = (ink: string, stops: readonly string[]) =>
  Math.min(...backgroundSamples(stops).map((c) => contrast(rgb(ink), c)));

describe("levelFor", () => {
  it.each([
    [0, 1], [9.99, 1], [10, 2], [55, 6], [72, 8], [79.6, 8], [89.99, 9], [90, 10], [99.9, 10], [100, 10],
  ])("score %s is level %s", (score, level) => {
    expect(levelFor(score)).toBe(level);
  });

  it("rejects a score that is not a number", () => {
    expect(() => levelFor(Number.NaN)).toThrow(RangeError);
  });
});

describe("displayScore", () => {
  it("rounds down, so the number never contradicts the level", () => {
    for (let s = 0; s <= 100; s += 0.1) {
      expect(levelFor(displayScore(s))).toBe(levelFor(s));
    }
    expect(displayScore(79.6)).toBe(79);
  });
});

describe("levelRange", () => {
  it("names the score band of a level", () => {
    expect(levelRange(1)).toBe("0 to 9");
    expect(levelRange(8)).toBe("70 to 79");
    expect(levelRange(10)).toBe("90 to 100");
  });
});

describe("tiers", () => {
  it("has the ten agreed colours in order", () => {
    expect(TIERS.map((t) => [t.level, ...t.stops])).toEqual([
      [1, "#A3ABA9"], [2, "#86A7A0"], [3, "#5FA296"], [4, "#2F9689"], [5, "#2A8AA0"],
      [6, "#3A74B8"], [7, "#5A5FC4"], [8, "#7B4FC0", "#3A74B8"], [9, "#A8479E", "#5A5FC4"],
      [10, "#E0A93A", "#A8479E"],
    ]);
  });

  it("uses a base colour that belongs to the tier background", () => {
    for (const t of TIERS) expect(t.stops).toContain(t.base);
  });

  it.each(TIERS.map((t) => [t.level, t]))("tier %s: ink reaches 4.5:1 on its base", (_, t) => {
    expect(contrast(rgb(t.ink), rgb(t.base))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(TIERS.filter((t) => t.level < 10).map((t) => [t.level, t]))(
    "tier %s: ink reaches 4.5:1 on every point of the background",
    (_, t) => {
      expect(minContrast(t.ink, t.stops)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("tier 10: no single text colour reaches 4.5:1 across gold to magenta, so ink keeps 3:1 for large marks", () => {
    const tier = tierFor(10);
    expect(minContrast("#000000", tier.stops)).toBeLessThan(4.5);
    expect(minContrast("#FFFFFF", tier.stops)).toBeLessThan(4.5);
    expect(minContrast(tier.ink, tier.stops)).toBeGreaterThanOrEqual(3);
  });

  it("clamps lookups into 1..10", () => {
    expect(tierFor(0).level).toBe(1);
    expect(tierFor(11).level).toBe(10);
  });

  it("describes solid and gradient backgrounds for CSS and Satori", () => {
    expect(tierBackground(tierFor(3))).toEqual({ backgroundColor: "#5FA296" });
    expect(tierBackground(tierFor(8))).toEqual({
      backgroundColor: "#7B4FC0",
      backgroundImage: "linear-gradient(135deg, #7B4FC0, #3A74B8)",
    });
  });
});
