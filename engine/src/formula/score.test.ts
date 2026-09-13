import { describe, expect, it } from "vitest";
import type { EvmChainFacts, GithubFacts, PersonFacts, RoleKey, SiteFacts, SourceKey, XFacts, YoutubeFacts } from "../types.js";
import { FORMULA_VERSION, levelOf, scorePerson } from "./score.js";
import { SCORED_ROLES } from "./roles.js";

const NOW = Date.UTC(2026, 8, 12);

const x = (o: Partial<XFacts> = {}): XFacts => ({ followers: 20_000, kol: 60, kolSourceGap: false, fetched: 100, own: 30,
  repliesMade: 70, own30d: 10, ownAvgLikesRt: 150, ownAvgViews: 12_000, ownAvgReplies: 12, daysCovered: 40, ...o });
const gh = (o: Partial<GithubFacts> = {}): GithubFacts => ({ createdAt: "2016-01-01T00:00:00Z", followers: 400, stars: 900,
  commits12m: 700, reviews12m: 60, mergedPrsElsewhere: 120, reposPushed12m: 6, reposWithSite: 2, ...o });
const yt = (o: Partial<YoutubeFacts> = {}): YoutubeFacts => ({ channelId: "UC1", subscribers: 30_000, hiddenSubscribers: false,
  avgViewsRecent: 4000, videos90d: 5, ...o });
const site = (o: Partial<SiteFacts> = {}): SiteFacts => ({ reachable: true, feedItems: 40, items90d: 3, sitemapUrls: 60,
  latestTs: null, ...o });
const chain = (o: Partial<EvmChainFacts> = {}): EvmChainFacts =>
  ({ sent: 800, sentCapped: false, firstTs: Math.round(NOW / 1000) - 4 * 365 * 86400, swaps: 120, source: "etherscan", ...o });

/** Людина з усіма джерелами. */
const full = (): PersonFacts => ({
  x: x(), github: gh(), youtube: yt(), site: site(),
  evm: { "0xa": { ethereum: chain(), base: chain({ sent: 50, swaps: 10 }) } },
  hyperliquid: { "0xa": { volumeUsd: 250_000, fillsRecent: 40 } },
  solana: { S1: { sigs: 900, sigsOk: 850, sigsCapped: false, firstTs: null, sampleSeen: 150, sampleSwaps: 60, swaps: 340 } },
  audits: { earningsUsd: 80_000, high: 12, contests: 9, providers: {}, verifiedBy: "github" },
  dune: { spellbookPrs: 25, spellbookPrs12m: 6 },
});

const scores = (f: PersonFacts) =>
  Object.fromEntries(Object.entries(scorePerson(f, NOW).roles).map(([k, r]) => [k, r.score])) as Record<RoleKey, number | null>;

describe("прогалина не нуль", () => {
  const facts = full();
  const cases: Array<[SourceKey, keyof PersonFacts]> = [["x", "x"], ["github", "github"], ["youtube", "youtube"],
    ["site", "site"], ["evm", "evm"], ["hyperliquid", "hyperliquid"], ["solana", "solana"], ["audits", "audits"], ["dune", "dune"]];

  for (const [gapKey, field] of cases) {
    it(`джерело ${field}, що не відповіло, дає ті самі бали, що й людина без нього`, () => {
      const without: PersonFacts = { ...facts, [field]: undefined };
      const gapped: PersonFacts = { ...facts, [field]: null, gaps: { [gapKey]: "HTTP 503" } };
      const a = scores(without);
      const b = scores(gapped);
      for (const role of Object.keys(a) as RoleKey[]) {
        if (a[role] === null) expect(b[role], role).toBeNull();
        else expect(b[role]!, role).toBeGreaterThanOrEqual(a[role]!);
      }
    });
  }

  it("прогалина підсигналу X піднімає, а не опускає bd проти нуля в тому самому підсигналі", () => {
    const gap = scorePerson({ x: x({ ownAvgViews: null }) }, NOW).roles.bd.score!;
    const zero = scorePerson({ x: x({ ownAvgViews: 0 }) }, NOW).roles.bd.score!;
    expect(gap).toBeGreaterThan(zero);
  });

  it("причина прогалини потрапляє в breakdown.gaps", () => {
    const r = scorePerson({ github: gh(), gaps: { x: "6551 timeout" } }, NOW).roles.engineer;
    expect(r.breakdown.gaps).toMatchObject({ x: "6551 timeout" });
  });

  it("X без KOL (kolSourceGap): бал X є, а причина видна як x.kol", () => {
    const r = scorePerson({ x: x({ kol: null, kolSourceGap: true }) }, NOW).roles.bd;
    expect(r.score).not.toBeNull();
    expect(r.breakdown.gaps).toEqual({ "x.kol": "KOL followers unavailable" });
    expect(scorePerson({ x: x() }, NOW).roles.bd.breakdown.gaps).toEqual({});
  });

  it("Solana з замалою неповною вибіркою пише причину в gaps", () => {
    const r = scorePerson({ solana: { S1: { sigs: 300, sigsOk: 300, sigsCapped: false, firstTs: null, sampleSeen: 30,
      sampleSwaps: 5, swaps: null } } }, NOW).roles.trader;
    expect(r.breakdown.gaps.solana).toBe("sample too small");
  });

  it("Solana з повною вибіркою менше 50 (договір §3, виняток): без прогалини, обміни рахуються", () => {
    const r = scorePerson({ solana: { S1: { sigs: 30, sigsOk: 30, sigsCapped: false, firstTs: null, sampleSeen: 30,
      sampleSwaps: 5, swaps: 5 } } }, NOW);
    expect(r.roles.trader.breakdown.gaps.solana).toBeUndefined();
    expect(r.sources.trading).toBeGreaterThan(0);
    expect(r.roles.trader.score).not.toBeNull();
  });

  it("примітки часткових гаманців (`solana.<адреса…>`) доходять до breakdown.gaps поруч із фактами", () => {
    const r = scorePerson({ solana: { S1: { sigs: 300, sigsOk: 300, sigsCapped: false, firstTs: null, sampleSeen: 150,
      sampleSwaps: 50, swaps: 100 } }, gaps: { "solana.S2abcdef": "Solana: HTTP 429" } }, NOW).roles.trader;
    expect(r.breakdown.gaps).toEqual({ "solana.S2abcdef": "Solana: HTTP 429" });
    expect(r.score).not.toBeNull();
  });
});

describe("додатки лише додають", () => {
  it("джерело-додаток, навіть слабке, не знижує бал ролі", () => {
    const weakSite = { site: site({ feedItems: 0, items90d: 0, sitemapUrls: 0 }) };
    const weakWallet = { evm: { "0xb": { ethereum: chain({ sent: 1, swaps: 0, firstTs: null }) } } };
    const weakX = { x: x({ followers: 3, kol: 0, ownAvgLikesRt: 0, ownAvgViews: 0, ownAvgReplies: 0, own: 0 }) };
    const cases: Array<[RoleKey, PersonFacts, PersonFacts]> = [
      ["engineer", { github: gh(), x: x() }, weakSite],
      ["engineer", { github: gh(), x: x() }, weakWallet],
      ["community", { x: x() }, weakWallet],
      ["bd", { x: x() }, weakSite],
      ["marketing_content", { youtube: yt() }, weakSite],
      ["trader", { evm: { "0xa": { ethereum: chain() } } }, weakX],
    ];
    for (const [role, base, extra] of cases) {
      const before = scorePerson(base, NOW).roles[role].score!;
      const after = scorePerson({ ...base, ...extra }, NOW).roles[role].score!;
      expect(before, role).not.toBeNull();
      expect(after, role).toBeGreaterThanOrEqual(before);
    }
  });

  it("у кожній ролі бал не нижчий за ядро, а різниця = сума додатків", () => {
    const res = scorePerson(full(), NOW);
    for (const [role, spec] of Object.entries(SCORED_ROLES)) {
      const r = res.roles[role as RoleKey];
      const add = Object.entries(spec.bonus).reduce((s, [k, mx]) => s + mx * (res.sources[k as keyof typeof res.sources] ?? 0) / 100, 0);
      expect(r.score!, role).toBeGreaterThanOrEqual(r.core!);
      expect(r.score!, role).toBeCloseTo(Math.min(100, r.core! + add), 0);
    }
  });

  it("бал ролі = ядро + додатки, і не більше 100", () => {
    const star: PersonFacts = {
      youtube: yt({ subscribers: 1_000_000, avgViewsRecent: 100_000, videos90d: 12 }),
      site: site({ feedItems: 100, items90d: 8, sitemapUrls: 150 }),
    };
    const r = scorePerson(star, NOW).roles.marketing_content;
    expect(r.core).toBeCloseTo(100, 6);
    expect(r.score).toBe(100);
    expect(r.level).toBe(10);
    const plain = scorePerson({ x: x() }, NOW).roles.bd;
    expect(plain.score).toBeCloseTo(plain.core!, 6);
  });
});

describe("головні джерела", () => {
  it("без головного джерела бал = null з причиною missing_anchor", () => {
    const r = scorePerson({ x: x() }, NOW).roles.engineer;
    expect(r.score).toBeNull();
    expect(r.level).toBeNull();
    expect(r.breakdown.reason).toBe("missing_anchor:gh_eng");
    expect(scorePerson({ github: gh() }, NOW).roles.creator_kol.breakdown.reason).toBe("missing_anchor:media");
  });

  it("головне джерело з нулем теж не якір", () => {
    const zeroGh = gh({ followers: 0, stars: 0, commits12m: 0, reviews12m: 0, mergedPrsElsewhere: 0 });
    expect(scorePerson({ github: zeroGh, x: x() }, NOW).roles.engineer.breakdown.reason).toBe("missing_anchor:gh_eng");
  });

  it("трейдер без жодного обміну і без прогалини: trading = 0, роль без якоря", () => {
    const r = scorePerson({ evm: { "0xa": { ethereum: chain({ swaps: 0 }) } } }, NOW).roles.trader;
    expect(r.breakdown.sources.trading).toBe(0);
    expect(r.score).toBeNull();
    expect(r.breakdown.reason).toBe("missing_anchor:trading");
  });
});

describe("аудитор безпеки: сильніший з двох шляхів", () => {
  const strongAudits = { earningsUsd: 600_000, high: 90, contests: 40, providers: {}, verifiedBy: "github" as const };
  const weakAudits = { earningsUsd: 1500, high: 0, contests: 1, providers: {}, verifiedBy: "github" as const };

  it("сильний рекорд конкурсів веде шлях audits", () => {
    const r = scorePerson({ github: gh({ mergedPrsElsewhere: 5, stars: 3 }), x: x(), audits: strongAudits }, NOW).roles.security_auditor;
    expect(r.breakdown.reason).toBe("path:audits");
    expect(Object.keys(r.breakdown.core)).toEqual(["audits", "gh_eng", "x"]);
    expect(r.cover).toBe(100);
  });

  it("слабкий привʼязаний рекорд не карає: береться gh_eng+x, бал не нижчий, ніж без конкурсів", () => {
    const base: PersonFacts = { github: gh(), x: x() };
    const without = scorePerson(base, NOW).roles.security_auditor;
    const withWeak = scorePerson({ ...base, audits: weakAudits }, NOW).roles.security_auditor;
    expect(withWeak.breakdown.reason).toBe("path:gh_eng+x");
    expect(withWeak.score).toBe(without.score);
  });

  it("лише конкурси, без GitHub, достатньо для якоря", () => {
    const r = scorePerson({ audits: strongAudits }, NOW).roles.security_auditor;
    expect(r.score).not.toBeNull();
    expect(r.breakdown.reason).toBe("path:audits");
  });
});

describe("трейдер (v6: розмір замість широти)", () => {
  const oldTs = Math.round(NOW / 1000) - 6 * 365 * 86400;
  /** Старий гаманець з великою кількістю tx на 4 мережах і `swaps` обмінами на кожній. */
  const spread = (swaps: number): PersonFacts => ({ evm: { "0xa": Object.fromEntries(["ethereum", "base", "arbitrum", "optimism"]
    .map((c) => [c, chain({ sent: 3000, swaps, firstTs: oldTs })])) } });

  it("20 угод на 4 мережах лишаються в смузі D навіть із сильним onchain", () => {
    const r = scorePerson(spread(5), NOW);
    expect(r.sources.onchain!).toBeGreaterThan(80);
    expect(r.roles.trader.score!).toBeLessThan(40);
  });

  it("бал росте з кількістю угод за тих самих мереж", () => {
    const at = (swaps: number) => scorePerson(spread(swaps), NOW).roles.trader.score!;
    expect(at(10)).toBeLessThan(at(100));
    expect(at(100)).toBeLessThan(at(1000));
  });

  it("breakdown пише formula v6 і ядро trading 90, onchain 10", () => {
    const b = scorePerson(spread(50), NOW).roles.trader.breakdown;
    expect(b.formula).toBe("v6");
    expect(Object.fromEntries(Object.entries(b.core).map(([k, e]) => [k, e.weight]))).toEqual({ trading: 90, onchain: 10 });
  });
});

describe("дані й дослідження", () => {
  it("без output: ядро = 0.8·x, причина x_only", () => {
    const r = scorePerson({ x: x() }, NOW).roles.data_research;
    const xs = scorePerson({ x: x() }, NOW).sources.x!;
    expect(r.breakdown.reason).toBe("x_only");
    expect(r.core).toBeCloseTo(0.8 * xs, 0);
    expect(r.score).toBeCloseTo(0.8 * xs, 0);
    expect(r.cover).toBe(50);
  });

  it("з output рахується як v4 (output 50, x 50), без x_only", () => {
    const r = scorePerson({ x: x(), dune: { spellbookPrs: 40, spellbookPrs12m: 10 } }, NOW).roles.data_research;
    expect(r.breakdown.reason).toBeNull();
    expect(r.cover).toBe(100);
  });
});

describe("рівень картки", () => {
  it("levelOf: 0→1, 9.99→1, 10→2, 99→10, 100→10", () => {
    expect([0, 9.99, 10, 99, 100].map(levelOf)).toEqual([1, 1, 2, 10, 10]);
  });

  it("рівень у результаті узгоджений з балом", () => {
    for (const r of Object.values(scorePerson(full(), NOW).roles)) {
      if (r.score === null) expect(r.level).toBeNull();
      else expect(r.level).toBe(levelOf(r.score));
    }
  });
});

describe("ролі, яких реліз 1 не рахує", () => {
  it("повертають null з причиною needs_cv або needs_portfolio навіть з повними фактами", () => {
    const roles = scorePerson(full(), NOW).roles;
    expect(roles.designer).toMatchObject({ score: null, level: null, breakdown: { reason: "needs_portfolio" } });
    for (const k of ["operations_support", "finance", "legal_compliance", "hr_recruiting"] as const) {
      expect(roles[k], k).toMatchObject({ score: null, level: null, breakdown: { reason: "needs_cv" } });
    }
  });
});

describe("breakdown_json", () => {
  it("має форму договору §4 і всі 15 ролей", () => {
    const res = scorePerson(full(), NOW);
    expect(res.formula).toBe(FORMULA_VERSION);
    expect(Object.keys(res.roles)).toHaveLength(15);
    const b = res.roles.product_manager.breakdown;
    expect(b.formula).toBe(FORMULA_VERSION);
    expect(Object.keys(b.sources).sort()).toEqual(
      ["audits", "dune", "gh_builder", "gh_eng", "media", "onchain", "output", "site", "trading", "x", "yt"]);
    expect(b.core).toEqual({ x: { weight: 50, value: res.sources.x }, gh_builder: { weight: 25, value: res.sources.gh_builder },
      site: { weight: 25, value: res.sources.site } });
    expect(b.bonus).toEqual({ onchain: { max: 5, value: res.sources.onchain }, gh_eng: { max: 5, value: res.sources.gh_eng } });
    expect(b.cover).toBe(res.roles.product_manager.cover);
    expect(b.level).toBe(res.roles.product_manager.level);
    expect(JSON.parse(JSON.stringify(b))).toEqual(b);
  });

  it("cover рахує лише ядро з не-null джерелами", () => {
    expect(scorePerson({ x: x() }, NOW).roles.product_manager.cover).toBe(50);
    expect(scorePerson({ x: x(), site: site() }, NOW).roles.product_manager.cover).toBe(75);
  });
});
