import { describe, expect, it } from "vitest";
import {
  srcAudits, srcDune, srcGhBuilder, srcGhEng, srcOnchain, srcSite, srcTrading, srcX, srcYt,
} from "../../../../engine/src/formula/sources";
import { RECIPES, SCORED_ROLE_KEYS } from "./recipes";
import { SOURCE_PARTS, WEIGHT_COLUMNS } from "./source-parts";

/**
 * Ваги на сторінці = ваги рушія: кожну частину ставимо на її максимум, решту на нуль, і рушій
 * має дати рівно показану вагу.
 */

const gh = { createdAt: "2020-01-01", followers: 0, stars: 0, commits12m: 0, reviews12m: 0, mergedPrsElsewhere: 0, reposPushed12m: 0, reposWithSite: 0 };
const x = { followers: 0, kol: 0, kolSourceGap: false, fetched: 0, own: 0, repliesMade: 0, own30d: 0, ownAvgLikesRt: 0, ownAvgViews: 0, ownAvgReplies: 0, daysCovered: 30 };
const yt = { channelId: "c", subscribers: 0, hiddenSubscribers: false, avgViewsRecent: 0, videos90d: 0 };
const wallet = { ageYears: 0, tx: 0, chains: [] as string[], trades: 1, tradeChains: [] as string[], hlVolume: 0, tradeGap: false };
const site = { reachable: true, feedItems: 0, items90d: 0, sitemapUrls: 0, latestTs: null };
const audits = { earningsUsd: 0, high: 0, contests: 0, providers: {}, verifiedBy: "github" as const };
const six = ["a", "b", "c", "d", "e", "f"];

const weights = (key: keyof typeof SOURCE_PARTS) => SOURCE_PARTS[key].map((p) => p.weight);

describe("SOURCE_PARTS", () => {
  it("adds up to 100 in every source", () => {
    for (const key of Object.keys(SOURCE_PARTS) as (keyof typeof SOURCE_PARTS)[]) {
      expect(weights(key).reduce((s, w) => s + w, 0), key).toBe(100);
    }
  });

  it("matches the engine's GitHub weights", () => {
    expect(srcGhEng({ ...gh, mergedPrsElsewhere: 1000 })).toBeCloseTo(35);
    expect(srcGhEng({ ...gh, stars: 5000 })).toBeCloseTo(25);
    expect(srcGhEng({ ...gh, reviews12m: 300 })).toBeCloseTo(15);
    expect(srcGhEng({ ...gh, followers: 3000 })).toBeCloseTo(15);
    expect(srcGhEng({ ...gh, commits12m: 2000 })).toBeCloseTo(10);
    expect(weights("gh_eng")).toEqual([35, 25, 15, 15, 10]);
    expect(srcGhBuilder({ ...gh, reposPushed12m: 12 })).toBeCloseTo(40);
    expect(srcGhBuilder({ ...gh, reposWithSite: 4 })).toBeCloseTo(30);
    expect(srcGhBuilder({ ...gh, commits12m: 1500 })).toBeCloseTo(30);
    expect(weights("gh_builder")).toEqual([40, 30, 30]);
  });

  it("matches the engine's X and YouTube weights", () => {
    expect(srcX({ ...x, kol: 1000 })).toBeCloseTo(30);
    expect(srcX({ ...x, followers: 500_000 })).toBeCloseTo(15);
    expect(srcX({ ...x, ownAvgLikesRt: 1500 })).toBeCloseTo(15);
    expect(srcX({ ...x, ownAvgViews: 150_000 })).toBeCloseTo(15);
    expect(srcX({ ...x, ownAvgReplies: 150 })).toBeCloseTo(15);
    expect(srcX({ ...x, own: 20 })).toBeCloseTo(10);
    expect(weights("x")).toEqual([30, 15, 15, 15, 15, 10]);
    expect(srcYt({ ...yt, subscribers: 1_000_000 })).toBeCloseTo(45);
    expect(srcYt({ ...yt, avgViewsRecent: 100_000 })).toBeCloseTo(35);
    expect(srcYt({ ...yt, videos90d: 12 })).toBeCloseTo(20);
    expect(weights("yt")).toEqual([45, 35, 20]);
  });

  it("matches the engine's onchain and trading weights", () => {
    expect(srcOnchain({ ...wallet, ageYears: 6 })).toBeCloseTo(35);
    expect(srcOnchain({ ...wallet, tx: 10_000 })).toBeCloseTo(35);
    expect(srcOnchain({ ...wallet, chains: six })).toBeCloseTo(30);
    expect(weights("onchain")).toEqual([35, 35, 30]);
    const trades = srcTrading({ ...wallet, trades: 10_000 })!;
    expect(trades).toBeCloseTo(60);
    expect(srcTrading({ ...wallet, trades: 10_000, hlVolume: 1_000_000_000 })! - trades).toBeCloseTo(30);
    expect(srcTrading({ ...wallet, trades: 10_000, tradeChains: six })! - trades).toBeCloseTo(10);
    expect(weights("trading")).toEqual([60, 30, 10]);
  });

  it("matches the engine's website, audit and Dune weights", () => {
    expect(srcSite(site)).toBeCloseTo(30);
    expect(srcSite({ ...site, feedItems: 100 })).toBeCloseTo(30 + 40);
    expect(srcSite({ ...site, items90d: 8 })).toBeCloseTo(30 + 20);
    expect(srcSite({ ...site, sitemapUrls: 150 })).toBeCloseTo(30 + 10);
    expect(weights("site")).toEqual([30, 40, 20, 10]);
    expect(srcAudits({ ...audits, earningsUsd: 1_000_000 })).toBeCloseTo(60);
    expect(srcAudits({ ...audits, high: 150 })).toBeCloseTo(40);
    expect(weights("audits")).toEqual([60, 40]);
    expect(srcDune({ spellbookPrs: 300, spellbookPrs12m: 0 })).toBeCloseTo(70);
    expect(srcDune({ spellbookPrs: 1, spellbookPrs12m: 50 })! - srcDune({ spellbookPrs: 1, spellbookPrs12m: 0 })!).toBeCloseTo(30);
    expect(weights("dune")).toEqual([70, 30]);
  });

  it("has a column for every source any role uses", () => {
    for (const role of SCORED_ROLE_KEYS) {
      const r = RECIPES[role];
      for (const [k] of [...r.paths.flat(), ...r.bonus]) expect(WEIGHT_COLUMNS, `${role}: ${k}`).toContain(k);
    }
  });
});
