import { describe, expect, it } from "vitest";
import { displayScore, FINISHES, LAVENDER_ACCENT, levelFor, levelRange, MINT_ACCENT, tierBackground, tierFor, TIERS } from "./tiers";

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
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(rgb(a)), luminance(rgb(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** Колір без відтінку: R, G і B різняться не більше ніж на 12 з 255. */
/** Без відтінку: холодні сірі напряму «Payday» (#5a5f6b, #2a2e37) теж рахуються нейтральними. */
function neutral(hex: string): boolean {
  const [r, g, b] = rgb(hex);
  return Math.max(r, g, b) - Math.min(r, g, b) <= 20;
}

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
  it("maps levels to five finishes: paper 1-3, mint 4-5, lavender 6-7, chrome 8-9, black 10", () => {
    expect(TIERS.map((t) => [t.level, t.finish])).toEqual([
      [1, "paper"], [2, "paper"], [3, "paper"],
      [4, "mint"], [5, "mint"],
      [6, "lavender"], [7, "lavender"],
      [8, "chrome"], [9, "chrome"],
      [10, "black"],
    ]);
    expect(FINISHES.map((f) => tierFor(f.sample).finish)).toEqual(["paper", "mint", "lavender", "chrome", "black"]);
  });

  it("gives the seal as many layers as the level", () => {
    for (const t of TIERS) expect(t.sealLayers).toBe(t.level);
  });

  it("uses no hue for paper, chrome and black: frames, sheens and seals are neutral", () => {
    for (const t of TIERS.filter((x) => x.finish === "paper" || x.finish === "chrome")) {
      for (const c of [t.frame, ...(t.sheen ?? []), t.window, t.ink, t.ink2, t.hairline, t.frameInk]) expect(neutral(c)).toBe(true);
    }
    // Чорна (10) картка сама неутральна: колір лишень на печатці (мʼята й лаванда нижчих обробок).
    const black = tierFor(10);
    for (const c of [black.frame, ...(black.sheen ?? []), black.window, black.ink, black.ink2, black.hairline]) {
      expect(neutral(c)).toBe(true);
    }
  });

  it("mint and lavender intentionally carry their named hue (round4: five colourful finishes)", () => {
    expect(neutral(tierFor(4).frame)).toBe(false);
    expect(neutral(tierFor(6).frame)).toBe(false);
  });

  it("draws the black (level 10) seal from mint and lavender, the two finishes below it", () => {
    expect(tierFor(10).sealInks).toEqual([MINT_ACCENT, LAVENDER_ACCENT]);
  });

  // Картка банківського формату: текст лежить просто на рамці, тож міряємо на кожній точці відблиску.
  it.each(TIERS.map((t) => [t.level, t]))("tier %s: text on the card reaches 4.5:1 on every stop of the frame", (_, t) => {
    for (const c of [t.frame, ...(t.sheen ?? [])]) {
      expect(contrast(t.ink, c)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.ink2, c)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(TIERS.map((t) => [t.level, t]))("tier %s: the set line reaches 4.5:1 on every stop of the frame", (_, t) => {
    for (const c of [t.frame, ...(t.sheen ?? [])]) expect(contrast(t.frameInk, c)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(TIERS.map((t) => [t.level, t]))("tier %s: seal lines keep 3:1 on the card", (_, t) => {
    expect(contrast(t.sealInks[0], t.frame)).toBeGreaterThanOrEqual(3);
  });

  it("clamps lookups into 1..10", () => {
    expect(tierFor(0).level).toBe(1);
    expect(tierFor(11).level).toBe(10);
  });

  it("describes sheen frames for CSS and Satori", () => {
    expect(tierBackground(tierFor(6))).toEqual({
      backgroundColor: "#d9ccf7",
      backgroundImage: "linear-gradient(135deg, #f6f2ff 0%, #d9ccf7 42%, #ece5fc 55%, #c0adf0 100%)",
    });
    expect(tierBackground({ ...tierFor(3), sheen: null })).toEqual({ backgroundColor: "#eceef1" });
  });
});
