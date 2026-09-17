import { describe, expect, it } from "vitest";
import type { IdentityKind } from "@/lib/identity/normalize";
import { explainRole, gapSentence, hasStaleVerifyGap, sourceState, type ScoreRow } from "./explain";

const row = (score: number | null, breakdown: object): ScoreRow => ({
  role: "engineer",
  score,
  breakdown_json: JSON.stringify(breakdown),
  formula_version: "v5",
  computed_at: "2026-09-12 10:00:00",
});
/** Усі перелічені джерела рахуються (перевірені або такі, що не потребують перевірки). */
const kinds = (...k: IdentityKind[]) => ({ counted: new Set<IdentityKind>(k), unverified: new Set<IdentityKind>() });

describe("explainRole", () => {
  it("shows core sources as weighted bars, bonuses, cover and level", () => {
    const view = explainRole(
      "engineer",
      row(72.6, {
        core: { gh_eng: { weight: 80, value: 81.4 }, x: { weight: 20, value: 46.3 } },
        bonus: { onchain: { max: 5, value: 91.7 }, site: { max: 5, value: null } },
        cover: 100,
        level: 8,
        reason: null,
        gaps: {},
      }),
      kinds("github", "x", "evm"),
    );
    expect(view).toMatchObject({
      state: "scored",
      name: "Engineer",
      score: 72,
      level: 8,
      cover: 100,
      core: [
        { key: "gh_eng", label: "GitHub engineering", weight: 80, value: 81 },
        { key: "x", label: "X", weight: 20, value: 46 },
      ],
      bonus: [
        { key: "onchain", weight: 5, value: 92 },
        { key: "site", label: "Website", weight: 5, value: null },
      ],
      reason: null,
    });
    // Сайт не підключено: порада про нього.
    expect(view.state === "scored" && view.tips).toEqual(["Connect your website: it can add up to 5 points."]);
  });

  it("explains a missing anchor as a source to connect", () => {
    const view = explainRole(
      "engineer",
      row(null, { core: { gh_eng: { weight: 80, value: null }, x: { weight: 20, value: 30 } }, reason: "missing_anchor:gh_eng" }),
      kinds("x"),
    );
    expect(view).toMatchObject({ state: "missing", reason: "Connect GitHub to get an Engineer score." });
    // Про GitHub уже каже причина, повтору в порадах немає.
    expect(view.state === "missing" && view.tips.some((t) => t.includes("GitHub"))).toBe(false);
  });

  it("asks a security auditor for GitHub only (Sherlock left setup on 13.09)", () => {
    const view = explainRole("security_auditor", row(null, { reason: "missing_anchor:audits,gh_eng" }), kinds());
    expect(view).toMatchObject({ reason: "Connect GitHub to get a Security auditor score." });
  });

  it("does not ask to connect what is connected but empty", () => {
    const view = explainRole("trader", row(null, { reason: "missing_anchor:trading" }), kinds("evm"));
    expect(view).toMatchObject({ reason: "We found nothing to score for Trader in your wallets yet." });
  });

  it("does not suggest YouTube when X already covers media", () => {
    const view = explainRole(
      "creator_kol",
      row(40, { core: { media: { weight: 100, value: 40 } }, bonus: { onchain: { max: 5, value: null } } }),
      kinds("x"),
    );
    expect(view.state === "scored" && view.tips).toEqual(["Connect a wallet: it can add up to 5 points."]);
  });

  it("suggests the heaviest missing source first and at most three", () => {
    const view = explainRole(
      "product_manager",
      row(30, {
        core: { x: { weight: 50, value: 40 }, gh_builder: { weight: 25, value: null }, site: { weight: 25, value: null } },
        bonus: { onchain: { max: 5, value: null }, gh_eng: { max: 5, value: null } },
      }),
      kinds("x"),
    );
    expect(view.state === "scored" && view.tips).toEqual([
      "Connect GitHub: it counts for 25% of this score.",
      "Connect your website: it counts for 25% of this score.",
      "Connect a wallet: it can add up to 5 points.",
    ]);
  });

  it("explains the security path and the X-only research score", () => {
    expect(
      explainRole("security_auditor", row(60, { reason: "path:gh_eng+x", core: {} }), kinds("github", "x")),
    ).toMatchObject({ reason: "Scored on GitHub and X.", tips: [] });
    expect(explainRole("data_research", row(40, { reason: "x_only" }), kinds("x"))).toMatchObject({
      reason: "Scored on X only, because we found no published work yet.",
    });
  });

  it("words gaps for people and keeps only those of this role", () => {
    const view = explainRole(
      "trader",
      row(50, {
        core: { trading: { weight: 80, value: null }, onchain: { weight: 20, value: 70 } },
        gaps: { solana: "sample too small", youtube: "not configured: YOUTUBE_KEY", "evm.base": "HTTP 502" },
      }),
      kinds("evm", "solana"),
    );
    expect(view.state === "scored" && view.gaps).toEqual([
      "Solana wallets: not enough transactions yet to judge trading.",
      "EVM wallets: we could not read it this time. It does not lower your score.",
    ]);
  });

  it("v7: a designer without work links is told to add them; every role can be scored", () => {
    expect(explainRole("designer", null, kinds())).toMatchObject({ state: "waiting" });
    expect(explainRole("designer", row(null, { formula: "v7", reason: "missing_anchor:links" }), kinds("x"))).toMatchObject({
      state: "missing",
      reason: "Add links to your work (portfolio, case studies, articles) in your profile to get a Designer score.",
    });
  });

  it("v7: a general role with nothing connected says what to connect", () => {
    expect(explainRole("finance", row(null, { formula: "v7", reason: "missing_anchor:best" }), kinds())).toMatchObject({
      state: "missing",
      reason: "Connect X, GitHub, a wallet or your website, or add links to your work, to get a Finance score.",
    });
  });

  it("v7: suggests adding work links while there are none", () => {
    const v = explainRole("engineer", row(60, { formula: "v7", core: { gh_eng: { weight: 40, value: 80 } }, bonus: { rep: { max: 25, value: 40 } } }), kinds("github", "x"));
    expect(v.state === "scored" && v.tips).toContain("Add links to your work in your profile: they count for every role.");
    const withLinks = explainRole("engineer", row(60, { formula: "v7", selfAddedLinks: true, core: { gh_eng: { weight: 40, value: 80 } } }), kinds("github"));
    expect(withLinks.state === "scored" && withLinks.tips).not.toContain("Add links to your work in your profile: they count for every role.");
  });

  it("waits when there is no row yet, and survives a broken breakdown", () => {
    expect(explainRole("bd", null, kinds())).toEqual({ role: "bd", name: "BD & partnerships", state: "waiting" });
    const broken = { ...row(55, {}), breakdown_json: "not json" };
    expect(explainRole("bd", broken, kinds())).toMatchObject({ state: "scored", score: 55, level: 6, core: [] });
  });
});

describe("unverified X and GitHub", () => {
  it("counts every connected source, verified or only typed in (trust model of 13.09)", () => {
    const state = sourceState([
      { kind: "x", verifiedAt: null },
      { kind: "github", verifiedAt: "2026-09-12 10:00:00" },
      { kind: "evm", verifiedAt: null },
      { kind: "site", verifiedAt: null },
    ]);
    expect([...state.counted].sort()).toEqual(["evm", "github", "site", "x"]);
    expect([...state.unverified]).toEqual([]);
  });

  it("asks to connect a missing anchor and never to verify one", () => {
    expect(explainRole("engineer", row(null, { reason: "missing_anchor:gh_eng" }), sourceState([]))).toMatchObject({
      reason: "Connect GitHub to get an Engineer score.",
    });
    expect(
      explainRole(
        "product_manager",
        row(30, { core: { x: { weight: 50, value: 40 }, gh_builder: { weight: 25, value: null } } }),
        sourceState([{ kind: "x", verifiedAt: null }]),
      ),
    ).toMatchObject({ tips: ["Connect GitHub: it counts for 25% of this score."] });
  });

  it("does not suggest Sherlock any more (removed from setup on 13.09)", () => {
    const view = explainRole(
      "security_auditor",
      row(40, { core: { audits: { weight: 60, value: null }, gh_eng: { weight: 25, value: 50 } }, reason: "path:gh_eng+x" }),
      sourceState([{ kind: "github", verifiedAt: null }]),
    );
    expect(JSON.stringify(view)).not.toMatch(/Sherlock/);
    expect(explainRole("security_auditor", row(null, { reason: "missing_anchor:audits,gh_eng" }), sourceState([]))).toMatchObject({
      reason: "Connect GitHub to get a Security auditor score.",
    });
  });

  it("a score from before 13.09 with the old 'not verified' gap asks for an update, not for a code", () => {
    const breakdown = { core: { x: { weight: 100, value: null } }, reason: "missing_anchor:x", gaps: { x: "not verified" } };
    const view = explainRole("bd", row(null, breakdown), sourceState([{ kind: "x", verifiedAt: null }]));
    expect(view).toMatchObject({
      reason: "Update your score: we now count your X without a code.",
      gaps: ["X: we read it on your next score update."],
    });
    expect(hasStaleVerifyGap(JSON.stringify(breakdown))).toBe(true);
    expect(hasStaleVerifyGap(JSON.stringify({ gaps: { site: "site: HTTP 404" } }))).toBe(false);
    expect(hasStaleVerifyGap(null)).toBe(false);
  });
});

describe("gapSentence", () => {
  it("never shows the raw technical reason", () => {
    expect(gapSentence("x", "6551 returned HTTP 500 at /open/twitter_user_info")).toBe(
      "X: we could not read it this time. It does not lower your score.",
    );
  });
});
