import { describe, expect, it } from "vitest";
import type { PublicCard } from "./store";
import { cardView, formatIssuedOn } from "./view";

const FIXTURE: PublicCard = {
  slug: "aB3_-x9QzK",
  role: "security_auditor",
  score: 72.4,
  level: 8,
  displayName: "alice",
  formulaVersion: "v5",
  createdAt: "2026-09-12 08:30:00",
};

describe("cardView", () => {
  it("builds everything the page and the image show", () => {
    const view = cardView(FIXTURE);
    expect(view).toMatchObject({
      roleName: "Security auditor",
      score: 72,
      level: 8,
      levelLabel: "Level 8 / 10",
      levelRange: "70 to 79",
      displayName: "alice",
      issuedOn: "12 Sep 2026",
      background: { backgroundColor: "#7B4FC0", backgroundImage: "linear-gradient(135deg, #7B4FC0, #3A74B8)" },
      summary: "alice: Security auditor, score 72 of 100, level 8 of 10",
    });
    expect(view.tier.ink).toBe("#FFFFFF");
    expect(view.patternSrc).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it("gives two cards of the same level different patterns", () => {
    const a = cardView(FIXTURE);
    const b = cardView({ ...FIXTURE, displayName: "bob" });
    expect(a.tier).toBe(b.tier);
    expect(a.patternSrc).not.toBe(b.patternSrc);
  });

  it("never shows anything but score, role, level, name and date", () => {
    const text = Object.values(cardView(FIXTURE))
      .filter((v) => typeof v === "string" && !v.startsWith("data:"))
      .join(" ");
    expect(text).not.toMatch(/0x[0-9a-f]{6}|https?:|u1/i);
  });
});

describe("formatIssuedOn", () => {
  it("reads SQLite time without the locale", () => {
    expect(formatIssuedOn("2026-01-03 23:59:59")).toBe("3 Jan 2026");
    expect(formatIssuedOn("garbage")).toBe("");
  });
});
