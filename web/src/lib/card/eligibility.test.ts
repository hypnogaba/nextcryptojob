import { describe, expect, it } from "vitest";
import { cardEligibility, walletMarker } from "./eligibility";

const none = { x: false, github: false };
const x = { x: true, github: false };
const gh = { x: false, github: true };

describe("cardEligibility (a card only with a verified anchor source)", () => {
  it.each(["engineer", "security_auditor"] as const)("%s needs a verified GitHub", (role) => {
    expect(cardEligibility(role, null, gh)).toEqual({ ok: true, walletsUnverified: false });
    const no = cardEligibility(role, null, x);
    expect(no.ok).toBe(false);
    expect(!no.ok && no.reason).toMatch(/Verify your GitHub/);
  });

  it.each(["bd", "community", "product_manager"] as const)("%s needs a verified X", (role) => {
    expect(cardEligibility(role, null, x)).toMatchObject({ ok: true });
    expect(cardEligibility(role, null, gh)).toMatchObject({ ok: false, reason: expect.stringMatching(/Verify your X/) });
  });

  it.each(["marketing_content", "creator_kol"] as const)("%s needs a verified X and says YouTube is not yet enough", (role) => {
    expect(cardEligibility(role, null, x)).toMatchObject({ ok: true });
    const no = cardEligibility(role, null, none);
    expect(!no.ok && no.reason).toMatch(/YouTube verification is coming soon/);
  });

  it("DevRel takes either a verified GitHub or a verified X", () => {
    expect(cardEligibility("devrel", null, gh)).toMatchObject({ ok: true });
    expect(cardEligibility("devrel", null, x)).toMatchObject({ ok: true });
    expect(cardEligibility("devrel", null, none)).toMatchObject({ ok: false });
  });

  it("Data & research scored on X only needs a verified X", () => {
    expect(cardEligibility("data_research", "x_only", gh)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/Verify your X/),
    });
    expect(cardEligibility("data_research", "x_only", x)).toMatchObject({ ok: true });
    expect(cardEligibility("data_research", null, gh)).toMatchObject({ ok: true });
    expect(cardEligibility("data_research", null, none)).toMatchObject({ ok: false });
  });

  it("Trader is allowed without verification, marked as wallets not verified", () => {
    expect(cardEligibility("trader", null, none)).toEqual({ ok: true, walletsUnverified: true });
  });

  it("roles without a score never get a card", () => {
    expect(cardEligibility("designer", null, { x: true, github: true })).toMatchObject({ ok: false });
  });
});

describe("walletMarker", () => {
  it("marks trader cards until wallet signatures exist, and nothing else", () => {
    expect(walletMarker("trader")).toBe("Wallets not verified");
    expect(walletMarker("engineer")).toBeNull();
  });
});
