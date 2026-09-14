import { describe, expect, it } from "vitest";
import { ROLES, type RoleKey } from "./roles";
import { cardEligibility } from "./eligibility";
import { SCORED_ROLE_KEYS } from "@/lib/roles/recipes";

describe("cardEligibility (trust model of 13.09: no verified source needed)", () => {
  it("allows a card for every scored role, with nothing verified", () => {
    for (const role of SCORED_ROLE_KEYS) expect(cardEligibility(role)).toEqual({ ok: true });
  });

  it("refuses roles that have no score yet", () => {
    const unscored = (Object.keys(ROLES) as RoleKey[]).filter((r) => !(SCORED_ROLE_KEYS as string[]).includes(r));
    expect(unscored).toEqual(["designer", "operations_support", "finance", "legal_compliance", "hr_recruiting"]);
    for (const role of unscored) expect(cardEligibility(role)).toMatchObject({ ok: false });
  });
});
