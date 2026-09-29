import { describe, expect, it } from "vitest";
import { V7_ROLES } from "../../../../engine/src/formula/v7";
import * as engine from "../../../../engine/src/formula/v7";
import { isScoredRole, unscoredNote } from "./catalog";
import {
  POSITION_CODE, RECIPES, recipeBonus, recipeCore, REP_POINTS, SCORED_ROLE_KEYS, WIDTH_EACH, WIDTH_MAX, WORK_POINTS, isLayeredFormula,
} from "./recipes";
import { ROLES } from "@/lib/card/roles";

describe("recipes (v7)", () => {
  it("scores 10 roles; the five without public proof have no recipe and no card", () => {
    expect(SCORED_ROLE_KEYS).toEqual((Object.keys(ROLES) as (keyof typeof ROLES)[]).filter(isScoredRole));
    expect(SCORED_ROLE_KEYS).toHaveLength(10);
    for (const r of ["designer", "operations_support", "finance", "legal_compliance", "hr_recruiting"] as const) {
      expect(isScoredRole(r), r).toBe(false);
      expect(unscoredNote(r), r).toBe("Not scored: no public proof for this role yet");
    }
  });

  it("agrees with the engine on which roles have no proof", () => {
    for (const role of Object.keys(ROLES) as (keyof typeof ROLES)[]) {
      expect(V7_ROLES[role].noProof === true, role).toBe(!isScoredRole(role));
    }
  });

  it("matches the engine: the same work weights and layers for every role", () => {
    expect([WORK_POINTS, REP_POINTS, WIDTH_MAX, WIDTH_EACH]).toEqual([engine.WORK_POINTS, engine.REP_POINTS, engine.WIDTH_MAX, engine.WIDTH_EACH]);
    for (const role of SCORED_ROLE_KEYS) {
      expect(V7_ROLES[role].noProof, role).toBeUndefined();
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
    expect(recipeBonus("engineer")).toBe("Reputation up to 25, and every other source you connect up to 5 each (20 in total)");
  });
});

describe("isLayeredFormula", () => {
  it("shows layers for v7 and every later formula, not for v6 or junk", () => {
    for (const v of ["v7", "v8", "v9", "v10"]) expect(isLayeredFormula(v), v).toBe(true);
    for (const v of ["v6", "v5", "", null, undefined, "v9b"]) expect(isLayeredFormula(v), String(v)).toBe(false);
  });
});
