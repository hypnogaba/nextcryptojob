import { describe, expect, it } from "vitest";
import type { GithubFacts, PersonFacts, XFacts, YoutubeFacts } from "../types.js";
import { ROLE_ORDER } from "./roles.js";
import {
  computeSourcesV7, FORMULA_VERSION, KOL_TOP, LINKS_TOP, REP_POINTS, reputation, scorePersonV7, srcGhEngV7, srcLinks, srcSiteV10, srcXV7,
  V7_ROLES, WIDTH_EACH, WIDTH_MAX, WORK_POINTS,
} from "./v7.js";

const NOW = Date.parse("2026-09-17T00:00:00Z");
const X: XFacts = { followers: 20_000, kol: 100, kolSourceGap: false, fetched: 100, own: 30, repliesMade: 5, own30d: 30,
  ownAvgLikesRt: 200, ownAvgViews: 20_000, ownAvgReplies: 20, daysCovered: 30 };
const GH: GithubFacts = { createdAt: "2018-01-01T00:00:00Z", followers: 800, stars: 1200, commits12m: 900, reviews12m: 60,
  mergedPrsElsewhere: 150, reposPushed12m: 8, reposWithSite: 2 };
const YT: YoutubeFacts = { channelId: "c", subscribers: 50_000, hiddenSubscribers: false, avgViewsRecent: 8_000, videos90d: 6 };

describe("v7: будова", () => {
  it("має роботу на WORK_POINTS у кожному шляху кожної ролі з доказами; решта 5 без шляхів", () => {
    expect(ROLE_ORDER).toHaveLength(15);
    for (const role of ROLE_ORDER) {
      for (const p of V7_ROLES[role].paths) expect(Object.values(p.work).reduce((a, b) => a + b, 0), role).toBe(WORK_POINTS);
      // Посилання (links) і «найсильніше» (best) більше не робота жодної ролі.
      for (const p of V7_ROLES[role].paths) expect(Object.keys(p.work), role).not.toEqual(expect.arrayContaining(["links"]));
      for (const p of V7_ROLES[role].paths) expect(Object.keys(p.work), role).not.toEqual(expect.arrayContaining(["best"]));
    }
    expect(ROLE_ORDER.filter((r) => V7_ROLES[r].noProof).sort()).toEqual(
      ["designer", "finance", "hr_recruiting", "legal_compliance", "operations_support"]);
    // v8: ширина до WIDTH_MAX зверху роботи й репутації; сума шарів може бути 105, бал обрізається на 100.
    expect([WORK_POINTS, REP_POINTS, WIDTH_EACH, WIDTH_MAX]).toEqual([60, 25, 5, 20]);
  });

  it("рахує 9 ролей з доказами (трейдеру потрібен гаманець), а 5 загальних лишає без балу з причиною", () => {
    const r = scorePersonV7({ x: X, github: GH, links: { count: 4 } }, NOW);
    expect(r.formula).toBe("v10");
    for (const role of ROLE_ORDER) {
      if (V7_ROLES[role].noProof || role === "trader") expect(r.roles[role].score, role).toBeNull();
      else expect(r.roles[role].score, role).not.toBeNull();
    }
  });

  it("v10 (B3): інженер без доказів з юриспруденції не має балу юриста, а причина названа", () => {
    const r = scorePersonV7({ github: { ...GH, followers: 3000, stars: 1e5, mergedPrsElsewhere: 1000 }, x: X }, NOW);
    for (const role of ["legal_compliance", "finance", "operations_support", "hr_recruiting", "designer"] as const) {
      expect(r.roles[role].score, role).toBeNull();
      expect(r.roles[role].level, role).toBeNull();
      expect(r.roles[role].breakdown.reason, role).toBe("no_public_proof");
      expect(r.roles[role].breakdown.gaps.role, role).toBe("no public proof for this role yet");
    }
    expect(r.roles.engineer.score).not.toBeNull();
  });

  it("v10 (B3): десять довільних посилань самі нічого не дають жодній ролі", () => {
    const r = scorePersonV7({ links: { count: 10 } }, NOW);
    for (const role of ROLE_ORDER) expect(r.roles[role].score, role).toBeNull();
    expect(r.sources.links).toBe(100); // показується, але не рахується
  });

  it("v10 (B3): посилання не додають балу й ролям з доказами (ні роботою, ні шириною)", () => {
    for (const role of ROLE_ORDER) {
      const a = scorePersonV7({ x: X, github: GH }, NOW).roles[role];
      const b = scorePersonV7({ x: X, github: GH, links: { count: 10 } }, NOW).roles[role];
      expect(b.score, role).toBe(a.score);
      expect(Object.keys(b.breakdown.bonus), role).not.toContain("links");
    }
  });
});

describe("v7: джерела", () => {
  it("v10: відомі підписники X лишаються в джерелі X (ворота: без них бал відомих людей падав на 10-14)", () => {
    expect(KOL_TOP).toBe(500);
    expect(srcXV7({ ...X, kol: 5000 })!).toBeGreaterThan(srcXV7({ ...X, kol: 0 })!);
    // Немає відповіді про KOL: вага випадає, а не рахується нулем.
    expect(srcXV7({ ...X, kol: 0, kolSourceGap: true })!).toBeGreaterThan(srcXV7({ ...X, kol: 0 })!);
    expect(reputation({ x: { ...X, kol: 500 } })).toBeCloseTo(100);
    expect(srcXV7({ ...X, followers: null })).toBeNull();
  });

  it("v10: підписники GitHub лишаються в коді; командні зірки ні", () => {
    const base = { ...GH, stars: 0, followers: 0, commits12m: 0, reviews12m: 0, mergedPrsElsewhere: 0 };
    expect(srcGhEngV7(base)).toBe(0);
    expect(srcGhEngV7({ ...base, followers: 100_000 })!).toBeGreaterThan(0);
    expect(srcGhEngV7({ ...base, teamStars: 5000 })).toBe(0);
    expect(srcGhEngV7({ ...base, teamCommits: 1000 })!).toBeGreaterThan(0);
    // Усе на межі = 100.
    expect(srcGhEngV7({ ...base, stars: 5000, reviews12m: 300, commits12m: 2000, mergedPrsElsewhere: 1000, followers: 3000 })).toBeCloseTo(100);
  });

  it("v10: репутація лишається єдиним місцем підписників (X KOL і GitHub followers)", () => {
    const r0 = scorePersonV7({ github: { ...GH, followers: 0 } }, NOW).roles.engineer.breakdown.layers!.rep;
    const r1 = scorePersonV7({ github: { ...GH, followers: 3000 } }, NOW).roles.engineer.breakdown.layers!.rep;
    expect(r0).toBe(0);
    expect(r1).toBe(REP_POINTS);
  });

  it("v10: сайт дає бали лише за вміст; порожній чи чужий досяжний сайт не дає 30", () => {
    expect(srcSiteV10(null)).toBeNull();
    expect(srcSiteV10({ reachable: false, feedItems: 100, items90d: 8, sitemapUrls: 150, latestTs: null })).toBeNull();
    expect(srcSiteV10({ reachable: true, feedItems: 0, items90d: 0, sitemapUrls: 0, latestTs: null })).toBe(0);
    expect(srcSiteV10({ reachable: true, feedItems: 100, items90d: 8, sitemapUrls: 150, latestTs: null })).toBeCloseTo(100);
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

  it("v9: репутація = більше з X і GitHub, тож X з кількома відомими підписниками її не знижує", () => {
    const gh = { ...GH, followers: 3000 };
    expect(reputation({ x: { ...X, kol: 10 }, github: gh })).toBeCloseTo(100);
    expect(reputation({ x: { ...X, kol: 500 }, github: { ...GH, followers: 0 } })).toBeCloseTo(100);
    expect(reputation({ x: { ...X, kol: 0 } })).toBe(0);
  });

  it("підключене джерело ніколи не знижує бал жодної ролі", () => {
    const wallet: PersonFacts = { evm: { "0xa": { eth: { firstTs: NOW / 1000 - 3 * 365 * 86400, sent: 500, swaps: 20 } } } } as unknown as PersonFacts;
    const extras: Array<[string, PersonFacts]> = [
      ["x", { x: { ...X, kol: 3, followers: 150, ownAvgLikesRt: 1, ownAvgViews: 50, ownAvgReplies: 0 } }],
      ["youtube", { youtube: { ...YT, subscribers: 100, avgViewsRecent: 10, videos90d: 1 } }],
      ["links", { links: { count: 1 } }],
      ["site", { site: { reachable: true, feedItems: 0, items90d: 0, sitemapUrls: 0, latestTs: null } }],
      ["wallet", wallet],
    ];
    const bases: PersonFacts[] = [{ github: { ...GH, followers: 3000 } }, { x: X }, { github: GH, x: X }];
    for (const base of bases) {
      const before = scorePersonV7(base, NOW).roles;
      for (const [name, extra] of extras) {
        const after = scorePersonV7({ ...base, ...extra, ...(base.x && extra.x ? { x: base.x } : {}) }, NOW).roles;
        for (const role of ROLE_ORDER) {
          if (before[role].score === null) continue;
          expect(after[role].score!, `${name} → ${role}`).toBeGreaterThanOrEqual(before[role].score!);
        }
      }
    }
  });

  it("найсильніше джерело й змішані (посилання в них не беруть участі)", () => {
    const s = computeSourcesV7({ x: X, youtube: YT, links: { count: 10 } }, NOW);
    expect(s.bestOf).toBe("x");
    expect(s.best).toBe(s.x);
    expect(s.media).toBe(Math.max(s.x!, s.yt!));
    expect(s.output).toBeNull();
    expect(s.links).toBe(100);
  });
});

describe("v8: шари", () => {
  it("робота + репутація + кожне інше джерело по 5", () => {
    const f: PersonFacts = { x: X, github: GH, youtube: YT, links: { count: 10 } };
    const r = scorePersonV7(f, NOW).roles.engineer;
    const s = computeSourcesV7(f, NOW);
    const work = (40 * s.gh_eng! + 20 * s.gh_builder!) / 100;
    const rep = (REP_POINTS * reputation(f)!) / 100;
    const others = [s.x!, s.yt!];
    const width = others.reduce((a, v) => a + (WIDTH_EACH * v) / 100, 0);
    expect(r.score).toBeCloseTo(Math.round((work + rep + width) * 10) / 10, 5);
    expect(r.breakdown.layers).toEqual({ work: r.core, rep: Math.round(rep * 10) / 10, width: Math.round(width * 10) / 10 });
    expect(Object.keys(r.breakdown.bonus).sort()).toEqual(["rep", "x", "yt"]);
    expect(r.breakdown.selfAddedLinks).toBe(true);
  });

  it("ширина бере всі інші джерела, а не три найсильніші, і не повторює джерела роботи", () => {
    const f: PersonFacts = { x: X, github: GH, youtube: YT, links: { count: 3 },
      site: { reachable: true, feedItems: 50, items90d: 4, sitemapUrls: 80, latestTs: null } };
    const kol = scorePersonV7(f, NOW).roles.creator_kol;
    const widthKeys = Object.keys(kol.breakdown.bonus).filter((k) => k !== "rep").sort();
    expect(widthKeys).toEqual(["gh_builder", "gh_eng", "site"]);
    // Четверте джерело додає бали: у v7 воно б не рахувалось.
    const s = computeSourcesV7(f, NOW);
    const width = [s.gh_eng!, s.gh_builder!, s.site!].reduce((a, v) => a + (WIDTH_EACH * v) / 100, 0);
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
    expect(r.operations_support.score).toBeNull();
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
    expect(scorePersonV7(top, NOW).roles.engineer.score).toBe(95); // v10: ширина без links (5)
  });
});
