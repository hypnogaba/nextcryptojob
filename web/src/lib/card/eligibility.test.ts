import { describe, expect, it } from "vitest";
import { ROLES, type RoleKey } from "./roles";
import { cardEligibility } from "./eligibility";
import { SCORED_ROLE_KEYS } from "@/lib/roles/recipes";

describe("cardEligibility (trust model of 13.09: no verified source needed)", () => {
  it("allows a card for every scored role, with nothing verified", () => {
    for (const role of SCORED_ROLE_KEYS) expect(cardEligibility(role)).toEqual({ ok: true });
  });

  it("v10: the five roles without public proof have no card; an unknown role has none either", () => {
    const unscored = (Object.keys(ROLES) as RoleKey[]).filter((r) => !(SCORED_ROLE_KEYS as string[]).includes(r));
    expect(unscored.sort()).toEqual(["designer", "finance", "hr_recruiting", "legal_compliance", "operations_support"]);
    for (const r of unscored) expect(cardEligibility(r)).toMatchObject({ ok: false });
    expect(cardEligibility("wizard" as RoleKey)).toMatchObject({ ok: false });
  });
});
