import { describe, expect, it } from "vitest";
import { sealSeed } from "./seal";
import type { PublicCard } from "./store";
import { cardView, formatIssuedOn, type CardEvidence } from "./view";

const FIXTURE: PublicCard = {
  slug: "aB3_-x9QzK",
  role: "security_auditor",
  score: 72.4,
  level: 8,
  displayName: "alice",
  formulaVersion: "v5",
  createdAt: "2026-09-12 08:30:00",
};

const EVIDENCE: CardEvidence = {
  score: 72.4,
  formulaVersion: "v5",
  breakdownJson: JSON.stringify({
    formula: "v5",
    core: { gh_eng: { weight: 70, value: 80 }, x: { weight: 30, value: 50 } },
    bonus: { site: { max: 5, value: null }, onchain: { max: 5, value: 94 } },
    cover: 100,
    level: 8,
    reason: "path:gh_eng+x",
    gaps: { "solana.BGjMfx5B": "partial: timeout" },
  }),
  wallet: null,
  connected: ["github", "x", "evm", "solana"],
};

describe("cardView", () => {
  it("builds everything the page and the image show", () => {
    const view = cardView(FIXTURE);
    expect(view).toMatchObject({
      kind: "real",
      roleName: "Security auditor",
      positionCode: "SEC",
      score: 72,
      level: 8,
      levelLabel: "Level 8 of 10",
      levelRange: "70 to 79",
      displayName: "alice",
      issuedOn: "12 Sep 2026",
      number: "No. aB3_-x9QzK",
      summary: "alice: Security auditor, score 72 of 100, level 8 of 10",
    });
    expect(view.tier.finish).toBe("chrome");
    expect(view.tier.sealLayers).toBe(8);
  });

  it("draws the seal from the card slug when there is no verified wallet", () => {
    expect(cardView(FIXTURE).sealSeed).toBe(sealSeed({ slug: FIXTURE.slug }));
    expect(cardView(FIXTURE, { ...EVIDENCE, wallet: "0xAbC0000000000000000000000000000000000001" }).sealSeed).toBe(
      sealSeed({ wallet: "0xabc0000000000000000000000000000000000001" }),
    );
  });

  it("puts no marker on any card, a trader card included (trust model of 13.09)", () => {
    const trader = cardView({ ...FIXTURE, role: "trader" });
    expect(trader.marker).toBeNull();
    expect(trader.summary).not.toMatch(/not verified/i);
    expect(cardView(FIXTURE).marker).toBeNull();
  });

  it("gives two cards of the same level different seals", () => {
    const a = cardView(FIXTURE);
    const b = cardView({ ...FIXTURE, slug: "zZ9_-x9QzK" });
    expect(a.tier).toBe(b.tier);
    expect(a.sealSeed).not.toBe(b.sealSeed);
  });

  it("puts the breakdown on the back while the score is still the one the card was issued with", () => {
    const view = cardView(FIXTURE, EVIDENCE);
    expect(view.back?.lines.map((l) => [l.name, l.weight, l.value])).toEqual([
      ["GitHub", 70, 80],
      ["X", 30, 50],
      ["Website", 5, null],
      ["Onchain", 5, 94],
    ]);
    expect(view.backMissing).toBeNull();
  });

  it("hides a newer breakdown behind an older card and says why", () => {
    const view = cardView(FIXTURE, { ...EVIDENCE, score: 75.1 });
    expect(view.back).toBeNull();
    expect(view.backMissing).toMatch(/changed after the card was issued on 12 Sep 2026/);
  });

  it("never shows a wallet, a link or an account id", () => {
    const view = cardView(FIXTURE, { ...EVIDENCE, wallet: "0xabc0000000000000000000000000000000000001" });
    const text = JSON.stringify(view);
    expect(text).not.toMatch(/0x[0-9a-f]{6}|https?:|u1|BGjMfx5B/i);
  });
});

describe("formatIssuedOn", () => {
  it("reads SQLite time without the locale", () => {
    expect(formatIssuedOn("2026-01-03 23:59:59")).toBe("3 Jan 2026");
    expect(formatIssuedOn("garbage")).toBe("");
  });
});
