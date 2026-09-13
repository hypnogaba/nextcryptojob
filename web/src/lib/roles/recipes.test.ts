import { describe, expect, it } from "vitest";
import { isScoredRole } from "./catalog";
import { POSITION_CODE, RECIPES, recipeBonus, recipeCore, SCORED_ROLE_KEYS } from "./recipes";
import { ROLES } from "@/lib/card/roles";

describe("recipes", () => {
  it("covers exactly the ten roles scored in release 1", () => {
    expect(SCORED_ROLE_KEYS).toEqual((Object.keys(ROLES) as (keyof typeof ROLES)[]).filter(isScoredRole));
    expect(SCORED_ROLE_KEYS).toHaveLength(10);
  });

  it("has core weights that add up to 100 on every path", () => {
    for (const role of SCORED_ROLE_KEYS) {
      for (const path of RECIPES[role].paths) expect(path.reduce((s, [, w]) => s + w, 0)).toBe(100);
    }
  });

  it("gives every role a short, unique position code", () => {
    const codes = Object.values(POSITION_CODE);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(c).toMatch(/^[A-Z]{2,3}$/);
  });

  it("reads the recipe like the contract", () => {
    expect(recipeCore("engineer")).toBe("GitHub 80, X 20");
    expect(recipeBonus("engineer")).toBe("Onchain up to 5, Website up to 5");
    expect(recipeCore("security_auditor")).toBe("Audit contests 60, GitHub 25, X 15, or GitHub 70, X 30");
  });
});
