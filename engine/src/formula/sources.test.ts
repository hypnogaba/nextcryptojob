import { describe, expect, it } from "vitest";
import type { AuditsFacts, GithubFacts, SiteFacts, XFacts, YoutubeFacts } from "../types.js";
import {
  computeSources, srcAudits, srcDune, srcGhBuilder, srcGhEng, srcOnchain, srcSite, srcTrading, srcX, srcYt,
} from "./sources.js";
import type { WalletSummary } from "./wallets.js";

const NOW = Date.UTC(2026, 8, 12);

const x = (o: Partial<XFacts> = {}): XFacts => ({ followers: 1000, kol: 5, kolSourceGap: false, fetched: 100, own: 10,
  repliesMade: 90, own30d: 3, ownAvgLikesRt: 20, ownAvgViews: 2000, ownAvgReplies: 3, daysCovered: 30, ...o });
const gh = (o: Partial<GithubFacts> = {}): GithubFacts => ({ createdAt: "2018-01-01T00:00:00Z", followers: 50, stars: 100,
  commits12m: 300, reviews12m: 20, mergedPrsElsewhere: 30, reposPushed12m: 4, reposWithSite: 1, ...o });
const yt = (o: Partial<YoutubeFacts> = {}): YoutubeFacts => ({ channelId: "UC1", subscribers: 5000, hiddenSubscribers: false,
  avgViewsRecent: 800, videos90d: 3, ...o });
const site = (o: Partial<SiteFacts> = {}): SiteFacts => ({ reachable: true, feedItems: 10, items90d: 2, sitemapUrls: 20,
  latestTs: null, ...o });
const audits = (o: Partial<AuditsFacts> = {}): AuditsFacts => ({ earningsUsd: 50_000, high: 10, contests: 8, providers: {},
  verifiedBy: "github", ...o });
const wallet = (o: Partial<WalletSummary> = {}): WalletSummary => ({ ageYears: 2, tx: 300, chains: ["ethereum"], trades: 10,
  tradeChains: ["ethereum"], hlVolume: 0, held: null, tradeGap: false, ...o });

describe("x", () => {
  it("без followers джерело не рахується", () => {
    expect(srcX(x({ followers: null }))).toBeNull();
    expect(srcX(null)).toBeNull();
  });

  it("прогалина підсигналу не тягне бал униз, а нуль тягне", () => {
    const gap = srcX(x({ ownAvgLikesRt: null, ownAvgViews: null, ownAvgReplies: null }))!;
    const zero = srcX(x({ ownAvgLikesRt: 0, ownAvgViews: 0, ownAvgReplies: 0 }))!;
    expect(gap).toBeGreaterThan(zero);
  });

  it("kolSourceGap прибирає kol зі знаменника, навіть якщо kol = 0", () => {
    expect(srcX(x({ kol: 0, kolSourceGap: true }))!).toBeGreaterThan(srcX(x({ kol: 0 }))!);
  });

  it("без покриття днів частота постів = прогалина", () => {
    const noSpan = srcX(x({ daysCovered: null, own: 0 }))!;
    expect(noSpan).toBeGreaterThan(srcX(x({ own: 0 }))!);
  });

  it("вершина галузі дає 100", () => {
    expect(srcX(x({ followers: 500_000, kol: 1000, ownAvgLikesRt: 1500, ownAvgViews: 150_000, ownAvgReplies: 150,
      own: 20, daysCovered: 30 }))).toBeCloseTo(100, 9);
  });
});

describe("github", () => {
  it("gh_eng і gh_builder: немає фактів → null; вершина → 100; більше доказів → вищий бал", () => {
    expect(srcGhEng(null)).toBeNull();
    expect(srcGhBuilder(null)).toBeNull();
    expect(srcGhEng(gh({ mergedPrsElsewhere: 1000, stars: 5000, reviews12m: 300, followers: 3000, commits12m: 2000 }))).toBeCloseTo(100, 9);
    expect(srcGhBuilder(gh({ reposPushed12m: 12, reposWithSite: 4, commits12m: 1500 }))).toBeCloseTo(100, 9);
    expect(srcGhEng(gh({ mergedPrsElsewhere: 300 }))!).toBeGreaterThan(srcGhEng(gh())!);
  });
});

describe("youtube", () => {
  it("без кількості підписників (прихована) джерело не рахується", () => {
    expect(srcYt(yt({ subscribers: null, hiddenSubscribers: true }))).toBeNull();
    expect(srcYt(yt({ subscribers: 1_000_000, avgViewsRecent: 100_000, videos90d: 12 }))).toBeCloseTo(100, 9);
  });

  it("прогалина переглядів не рахується нулем", () => {
    expect(srcYt(yt({ avgViewsRecent: null }))!).toBeGreaterThan(srcYt(yt({ avgViewsRecent: 0 }))!);
  });
});

describe("onchain і trading", () => {
  it("без гаманців обидва null", () => {
    expect(srcOnchain(null)).toBeNull();
    expect(srcTrading(null)).toBeNull();
  });

  it("невідомий вік випадає зі знаменника", () => {
    expect(srcOnchain(wallet({ ageYears: null }))!).toBeGreaterThan(srcOnchain(wallet({ ageYears: 0 }))!);
  });

  it("0 угод без прогалини = 0 (доказ відсутності), з прогалиною = null (невідомо)", () => {
    expect(srcTrading(wallet({ trades: 0 }))).toBe(0);
    expect(srcTrading(wallet({ trades: 0, tradeGap: true }))).toBeNull();
  });

  it("held = null не тягне торгівлю вниз", () => {
    const top = wallet({ trades: 3000, tradeChains: ["a", "b", "c", "d"], hlVolume: 5_000_000, held: null });
    expect(srcTrading(top)).toBeCloseTo(100, 9);
  });
});

describe("site", () => {
  it("недоступний → null; доступний без текстів = 30 (сайт існує); вершина = 100", () => {
    expect(srcSite(site({ reachable: false }))).toBeNull();
    expect(srcSite(site({ feedItems: 0, items90d: 0, sitemapUrls: 0 }))).toBe(30);
    expect(srcSite(site({ feedItems: 100, items90d: 8, sitemapUrls: 150 }))).toBeCloseTo(100, 9);
  });
});

describe("audits (v5)", () => {
  it("прогалина або невідомий заробіток → null, а не слабкий аудитор", () => {
    expect(srcAudits(audits({ gap: "no contests", earningsUsd: 0 }))).toBeNull();
    expect(srcAudits(audits({ earningsUsd: null }))).toBeNull();
    expect(srcAudits(null)).toBeNull();
  });

  it("$1M і 150 High = 100; невідомі High випадають зі знаменника", () => {
    expect(srcAudits(audits({ earningsUsd: 1_000_000, high: 150 }))).toBeCloseTo(100, 9);
    expect(srcAudits(audits({ earningsUsd: 1_000_000, high: null }))).toBeCloseTo(100, 9);
    expect(srcAudits(audits({ earningsUsd: 1_000_000, high: 0 }))).toBeCloseTo(60, 9);
  });
});

describe("dune (v5)", () => {
  it("0 або невідомо PR → null; 300 і 50 за рік = 100", () => {
    expect(srcDune({ spellbookPrs: 0, spellbookPrs12m: 0 })).toBeNull();
    expect(srcDune({ spellbookPrs: null, spellbookPrs12m: null })).toBeNull();
    expect(srcDune(null)).toBeNull();
    expect(srcDune({ spellbookPrs: 300, spellbookPrs12m: 50 })).toBeCloseTo(100, 9);
  });
});

describe("похідні: media і output", () => {
  it("media = сильніше з X і YouTube; одне відсутнє не тягне вниз", () => {
    const weakX = x({ followers: 10, kol: 0, ownAvgLikesRt: 0, ownAvgViews: 0, ownAvgReplies: 0, own: 0 });
    const strongYt = yt({ subscribers: 1_000_000, avgViewsRecent: 100_000, videos90d: 12 });
    const s = computeSources({ x: weakX, youtube: strongYt }, NOW);
    expect(s.media).toBe(Math.max(s.x!, s.yt!));
    expect(s.media).toBeCloseTo(100, 9);
    expect(computeSources({ x: weakX }, NOW).media).toBe(computeSources({ x: weakX }, NOW).x);
    expect(computeSources({}, NOW).media).toBeNull();
  });

  it("output = найсильніше з site, gh_eng, dune", () => {
    const s = computeSources({ site: site({ feedItems: 0, items90d: 0, sitemapUrls: 0 }), github: gh({ mergedPrsElsewhere: 0,
      stars: 0, reviews12m: 0, followers: 0, commits12m: 0 }), dune: { spellbookPrs: 300, spellbookPrs12m: 50 } }, NOW);
    expect(s.output).toBeCloseTo(100, 9);
    expect(computeSources({ site: site({ feedItems: 0, items90d: 0, sitemapUrls: 0 }) }, NOW).output).toBe(30);
    expect(computeSources({}, NOW).output).toBeNull();
  });
});
