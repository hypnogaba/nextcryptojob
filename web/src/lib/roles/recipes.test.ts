import { describe, expect, it } from "vitest";
import { V7_ROLES } from "../../../../engine/src/formula/v7";
import * as engine from "../../../../engine/src/formula/v7";
import { isScoredRole } from "./catalog";
import {
  POSITION_CODE, RECIPES, recipeBonus, recipeCore, REP_POINTS, SCORED_ROLE_KEYS, WIDTH_EACH, WIDTH_SOURCES, WORK_POINTS,
} from "./recipes";
import { ROLES } from "@/lib/card/roles";

describe("recipes (v7)", () => {
  it("scores all 15 roles", () => {
    expect(SCORED_ROLE_KEYS).toEqual((Object.keys(ROLES) as (keyof typeof ROLES)[]).filter(isScoredRole));
    expect(SCORED_ROLE_KEYS).toHaveLength(15);
  });

  it("matches the engine: the same work weights and layers for every role", () => {
    expect([WORK_POINTS, REP_POINTS, WIDTH_SOURCES, WIDTH_EACH]).toEqual([engine.WORK_POINTS, engine.REP_POINTS, engine.WIDTH_SOURCES, engine.WIDTH_EACH]);
    for (const role of SCORED_ROLE_KEYS) {
      const ours = RECIPES[role].paths.map((p) => Object.fromEntries(p));
      const theirs = V7_ROLES[role].paths.map((p) => p.work);
      expect(ours, role).toEqual(theirs);
      for (const p of RECIPES[role].paths) expect(p.reduce((s, [, w]) => s + w, 0)).toBe(WORK_POINTS);
    }
  });

  it("gives every role a short, unique position code", () => {
    const codes = Object.values(POSITION_CODE);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(c).toMatch(/^[A-Z]{2,3}$/);
  });

  it("reads the recipe in words", () => {
    expect(recipeCore("engineer")).toBe("GitHub 40, GitHub projects 20");
    expect(recipeCore("security_auditor")).toBe("Audit contests 30, GitHub 30, or GitHub 60");
    expect(recipeCore("designer")).toBe("Work links 40, X 20");
    expect(recipeCore("finance")).toBe("Strongest source 40, Work links 20");
    expect(recipeBonus("engineer")).toBe("Reputation up to 25, and your 3 strongest other sources up to 5 each");
  });
});
