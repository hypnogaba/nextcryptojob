import { describe, expect, it } from "vitest";
import { builtFrom, cardBack, missingReason } from "./back";
import { EXAMPLE_BACK, EXAMPLE_BREAKDOWN, EXAMPLE_SCORE } from "./example";

describe("cardBack", () => {
  it("itemizes the formula: weight, value and points per source, core, bonus and cover", () => {
    const back = cardBack(JSON.stringify(EXAMPLE_BREAKDOWN), new Set(["github", "x", "evm"] as const))!;
    expect(back.lines.map((l) => [l.name, l.kind, l.weight, l.value, l.points])).toEqual([
      ["GitHub", "core", 80, 74.2, 59.4],
      ["X", "core", 20, 46.3, 9.3],
      ["Onchain", "bonus", 5, 91.7, 4.6],
      ["Website", "bonus", 5, null, 0],
    ]);
    expect(back.core).toBe(68.6);
    expect(back.bonus).toBe(4.6);
    expect(back.cover).toBe(100);
    expect(Math.floor(back.core + back.bonus)).toBe(Math.floor(EXAMPLE_SCORE));
  });

  it("renders a v6 trader breakdown with the weights it was scored with (trading 90, onchain 10)", () => {
    const back = cardBack({
      formula: "v6",
      core: { trading: { weight: 90, value: 60 }, onchain: { weight: 10, value: 80 } },
      bonus: { x: { max: 5, value: 40 }, site: { max: 5, value: 30 } },
      cover: 100,
      reason: null,
      gaps: {},
    })!;
    expect(back.lines.map((l) => [l.name, l.kind, l.weight, l.value, l.points])).toEqual([
      ["Trading", "core", 90, 60, 54],
      ["Onchain", "core", 10, 80, 8],
      ["X", "bonus", 5, 40, 2],
      ["Website", "bonus", 5, 30, 1.5],
    ]);
    expect(back.core).toBe(62);
    expect(back.bonus).toBe(3.5);
  });

  it("still renders a v5 trader breakdown as it was scored (trading 80, onchain 20)", () => {
    const back = cardBack({
      formula: "v5",
      core: { trading: { weight: 80, value: 60 }, onchain: { weight: 20, value: 80 } },
      bonus: {},
      cover: 100,
    })!;
    expect(back.lines.map((l) => [l.key, l.weight, l.points])).toEqual([["trading", 80, 48], ["onchain", 20, 16]]);
    expect(back.core).toBe(64);
  });

  it("prints a missing source as null with a human reason, never as a zero value", () => {
    const site = EXAMPLE_BACK.lines.find((l) => l.key === "site")!;
    expect(site.value).toBeNull();
    expect(site.reason).toBe("no website linked");
  });

  it("names the reason from the gap, without the wallet address after the dot", () => {
    const reason = missingReason("trading", { "solana.BGjMfx5B": "sample too small" }, new Set(["solana"]));
    expect(reason).toBe("too few trades to judge");
    expect(missingReason("onchain", { "evm.base": "timeout" })).toBe("we could not read it this time");
    expect(missingReason("site", {}, new Set(["x"]))).toBe("no website linked");
    expect(missingReason("site", {})).toBe("no public data found");
  });

  it("counts X at 80 when a data researcher has no published work (x_only)", () => {
    const back = cardBack({
      core: { output: { weight: 50, value: null }, x: { weight: 50, value: 50 } },
      bonus: {},
      cover: 50,
      reason: "x_only",
    })!;
    expect(back.lines.map((l) => [l.key, l.weight, l.points])).toEqual([
      ["x", 80, 40],
      ["output", 0, 0],
    ]);
    expect(back.core).toBe(40);
    expect(back.note).toMatch(/X counts for 80/);
  });

  it("has no back without a core (no score yet, or broken JSON)", () => {
    expect(cardBack("{}")).toBeNull();
    expect(cardBack("not json")).toBeNull();
  });
});

describe("builtFrom", () => {
  it("says what the score was built from", () => {
    expect(builtFrom(EXAMPLE_BACK)).toBe("Built from GitHub 74.2, X 46.3 and an onchain bonus.");
    expect(builtFrom(null)).toBeNull();
  });
});
