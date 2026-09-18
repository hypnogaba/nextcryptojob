import { describe, expect, it } from "vitest";
import type { GithubFacts, PersonFacts, XFacts, YoutubeFacts } from "../types.js";
import { ROLE_ORDER } from "./roles.js";
import {
  computeSourcesV7, FORMULA_VERSION, KOL_TOP, LINKS_TOP, REP_POINTS, reputation, scorePersonV7, srcGhEngV7, srcLinks, srcXV7,
  V7_ROLES, WIDTH_EACH, WIDTH_MAX, WORK_POINTS,
} from "./v7.js";

const NOW = Date.parse("2026-09-17T00:00:00Z");
const X: XFacts = { followers: 20_000, kol: 100, kolSourceGap: false, fetched: 100, own: 30, repliesMade: 5, own30d: 30,
  ownAvgLikesRt: 200, ownAvgViews: 20_000, ownAvgReplies: 20, daysCovered: 30 };
const GH: GithubFacts = { createdAt: "2018-01-01T00:00:00Z", followers: 800, stars: 1200, commits12m: 900, reviews12m: 60,
  mergedPrsElsewhere: 150, reposPushed12m: 8, reposWithSite: 2 };
const YT: YoutubeFacts = { channelId: "c", subscribers: 50_000, hiddenSubscribers: false, avgViewsRecent: 8_000, videos90d: 6 };

describe("v7: будова", () => {
  it("має роботу на WORK_POINTS у кожному шляху кожної з 15 ролей", () => {
    expect(ROLE_ORDER).toHaveLength(15);
    for (const role of ROLE_ORDER) {
      for (const p of V7_ROLES[role].paths) expect(Object.values(p.work).reduce((a, b) => a + b, 0), role).toBe(WORK_POINTS);
    }
    // v8: ширина до WIDTH_MAX зверху роботи й репутації; сума шарів може бути 105, бал обрізається на 100.
    expect([WORK_POINTS, REP_POINTS, WIDTH_EACH, WIDTH_MAX]).toEqual([60, 25, 5, 20]);
  });

  it("рахує кожну роль, зокрема дизайнера й загальні ролі", () => {
    const r = scorePersonV7({ x: X, github: GH, links: { count: 4 } }, NOW);
    expect(r.formula).toBe(FORMULA_VERSION);
    for (const role of ROLE_ORDER) if (role !== "trader") expect(r.roles[role].score, role).not.toBeNull();
    // Трейдеру потрібен гаманець.
    expect(r.roles.trader.score).toBeNull();
    expect(r.roles.finance.breakdown.bestOf).toBe("gh_eng");
  });
});

describe("v7: джерела", () => {
  it("X: KOL_TOP відомих підписників уже дають повну частину", () => {
    expect(KOL_TOP).toBe(500);
    const full = { ...X, followers: 0, ownAvgLikesRt: 0, ownAvgViews: 0, ownAvgReplies: 0, own: 0, kol: 500 };
    expect(srcXV7(full)).toBeCloseTo(30);
    expect(srcXV7({ ...full, kol: 5000 })).toBeCloseTo(30);
    expect(srcXV7({ ...X, followers: null })).toBeNull();
  });

  it("код: командні зірки додаються до власних", () => {
    const base = { ...GH, stars: 0, followers: 0, commits12m: 0, reviews12m: 0, mergedPrsElsewhere: 0 };
    expect(srcGhEngV7(base)).toBe(0);
    expect(srcGhEngV7({ ...base, teamStars: 5000 })).toBeCloseTo(25);
    expect(srcGhEngV7({ ...base, stars: 2500, teamStars: 2500 })).toBeCloseTo(25);
  });

  it("посилання: лише кількість, до LINKS_TOP; нуль посилань = немає джерела", () => {
    expect(srcLinks(null)).toBeNull();
    expect(srcLinks({ count: 0 })).toBeNull();
    expect(srcLinks({ count: 5 })).toBe(50);
    expect(srcLinks({ count: LINKS_TOP + 5 })).toBe(100);
  });

  it("репутація з X, а без X або з прогалиною KOL з підписників GitHub", () => {
    expect(reputation({ x: { ...X, kol: 500 } })).toBeCloseTo(100);
    expect(reputation({ x: { ...X, kolSourceGap: true }, github: { ...GH, followers: 3000 } })).toBeCloseTo(100);
    expect(reputation({ github: { ...GH, followers: 0 } })).toBe(0);
    expect(reputation({})).toBeNull();
  });

  it("найсильніше джерело й змішані", () => {
    const s = computeSourcesV7({ x: X, youtube: YT, links: { count: 10 } }, NOW);
    expect(s.bestOf).toBe("links");
    expect(s.best).toBe(100);
    expect(s.media).toBe(Math.max(s.x!, s.yt!));
    expect(s.output).toBe(100);
  });
});

describe("v8: шари", () => {
  it("робота + репутація + кожне інше джерело по 5", () => {
    const f: PersonFacts = { x: X, github: GH, youtube: YT, links: { count: 10 } };
    const r = scorePersonV7(f, NOW).roles.engineer;
    const s = computeSourcesV7(f, NOW);
    const work = (40 * s.gh_eng! + 20 * s.gh_builder!) / 100;
    const rep = (REP_POINTS * reputation(f)!) / 100;
    const others = [s.x!, s.yt!, s.links!].sort((a, b) => b - a);
    const width = others.reduce((a, v) => a + (WIDTH_EACH * v) / 100, 0);
    expect(r.score).toBeCloseTo(Math.round((work + rep + width) * 10) / 10, 5);
    expect(r.breakdown.layers).toEqual({ work: r.core, rep: Math.round(rep * 10) / 10, width: Math.round(width * 10) / 10 });
    expect(Object.keys(r.breakdown.bonus).sort()).toEqual(["links", "rep", "x", "yt"]);
    expect(r.breakdown.selfAddedLinks).toBe(true);
  });

  it("ширина бере всі інші джерела, а не три найсильніші, і не повторює джерела роботи", () => {
    const f: PersonFacts = { x: X, github: GH, youtube: YT, links: { count: 3 },
      site: { reachable: true, feedItems: 50, items90d: 4, sitemapUrls: 80, latestTs: null } };
    const kol = scorePersonV7(f, NOW).roles.creator_kol;
    const widthKeys = Object.keys(kol.breakdown.bonus).filter((k) => k !== "rep").sort();
    expect(widthKeys).toEqual(["gh_builder", "gh_eng", "links", "site"]);
    // Четверте джерело додає бали: у v7 воно б не рахувалось.
    const s = computeSourcesV7(f, NOW);
    const width = [s.gh_eng!, s.gh_builder!, s.links!, s.site!].reduce((a, v) => a + (WIDTH_EACH * v) / 100, 0);
    expect(kol.breakdown.layers!.width).toBeCloseTo(Math.round(Math.min(WIDTH_MAX, width) * 10) / 10, 5);
  });

  it("ширина не більша за WIDTH_MAX, і нове джерело ніколи не знижує бал", () => {
    const top = (v: number) => ({ ...GH, stars: v, followers: v, commits12m: v, reviews12m: v, mergedPrsElsewhere: v, reposPushed12m: 50, reposWithSite: 10 });
    const f: PersonFacts = { x: X, github: top(1e5), youtube: { ...YT, subscribers: 1e7, avgViewsRecent: 1e6, videos90d: 50 }, links: { count: 20 },
      site: { reachable: true, feedItems: 500, items90d: 20, sitemapUrls: 500, latestTs: null },
      audits: { earningsUsd: 1_000_000, high: 150, contests: 40, providers: {}, verifiedBy: "github" as const } };
    const bd = scorePersonV7(f, NOW).roles.bd;
    expect(bd.breakdown.layers!.width).toBe(WIDTH_MAX);
    const without = scorePersonV7({ ...f, audits: undefined }, NOW).roles.bd;
    expect(bd.score!).toBeGreaterThanOrEqual(without.score!);
  });

  it("лише X: робота й репутація, без ширини; бал не вище WORK+REP", () => {
    const r = scorePersonV7({ x: { ...X, kol: 1000, followers: 1_000_000, ownAvgLikesRt: 5000, ownAvgViews: 1e6, ownAvgReplies: 500 } }, NOW);
    expect(r.roles.creator_kol.score).toBe(WORK_POINTS + REP_POINTS);
    expect(r.roles.creator_kol.breakdown.layers!.width).toBe(0);
  });

  it("без головного джерела бал не ставимо, навіть з репутацією", () => {
    const r = scorePersonV7({ x: X }, NOW).roles;
    expect(r.engineer.score).toBeNull();
    expect(r.engineer.breakdown.reason).toBe("missing_anchor:gh_eng");
    expect(r.trader.score).toBeNull();
    expect(r.designer.score).toBeNull();
    expect(r.operations_support.score).not.toBeNull();
  });

  it("аудитор: шлях з аудитами, коли він сильніший, інакше лише код", () => {
    const audits = { earningsUsd: 1_000_000, high: 150, contests: 40, providers: {}, verifiedBy: "github" as const };
    const withA = scorePersonV7({ github: GH, audits }, NOW).roles.security_auditor;
    const withoutA = scorePersonV7({ github: GH }, NOW).roles.security_auditor;
    expect(withA.breakdown.reason).toBe("path:audits");
    expect(withoutA.breakdown.reason).toBe("path:gh_eng");
    expect(withA.score!).toBeGreaterThan(withoutA.score!);
  });

  it("бал не перевищує 100", () => {
    const top: PersonFacts = {
      x: { ...X, kol: 1000, followers: 1e6, ownAvgLikesRt: 1e4, ownAvgViews: 1e6, ownAvgReplies: 1e3, own: 100 },
      github: { ...GH, stars: 1e5, followers: 1e5, commits12m: 1e4, reviews12m: 1e3, mergedPrsElsewhere: 1e4, reposPushed12m: 50, reposWithSite: 10 },
      youtube: { ...YT, subscribers: 1e7, avgViewsRecent: 1e6, videos90d: 50 }, links: { count: 20 },
    };
    for (const role of ROLE_ORDER) expect(scorePersonV7(top, NOW).roles[role].score ?? 0).toBeLessThanOrEqual(100);
    expect(scorePersonV7(top, NOW).roles.engineer.score).toBe(100);
  });
});
