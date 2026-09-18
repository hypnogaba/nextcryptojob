// Формула v9 (18.09.2026). v8: «кожен може отримати бали за все», ширина за всі джерела. v9: репутація =
// більше з X і GitHub, щоб підключення X ніколи не знижувало бал.
// Бал = Робота + Репутація + Ширина. Робота: головні джерела ролі, WORK_POINTS балів. Репутація: відомі
// крипто-акаунти серед підписників X або підписники GitHub, що більше; REP_POINTS для всіх ролей. Ширина: КОЖНЕ
// інше підключене джерело людини, по WIDTH_EACH, разом не більше WIDTH_MAX. Файл лишився v7.ts заради історії.
// Чисті функції, без IO. v6 лишається в score-v6.ts для звірки з Python.
import type { GithubFacts, LinksFacts, PersonFacts, RoleKey, XFacts } from "../types.js";
import { combine, lin, logn, maxOf } from "./math.js";
import { ROLE_ORDER } from "./roles.js";
import { srcAudits, srcDune, srcGhBuilder, srcOnchain, srcSite, srcTrading, srcYt } from "./sources.js";
import { SOLANA_MIN_SAMPLE, aggregateWallets, solanaSwapsKnown } from "./wallets.js";

export const FORMULA_VERSION = "v9" as const;

export const WORK_POINTS = 60;
export const REP_POINTS = 25;
/** Кожне інше джерело дає до WIDTH_EACH, разом до WIDTH_MAX (v7: лише 3 найсильніші по 5). */
export const WIDTH_EACH = 5;
export const WIDTH_MAX = 20;
/** Відомих крипто-підписників, з яких репутація (і частина X) повна. v6: 1000. */
export const KOL_TOP = 500;
/** Підписників GitHub для повної репутації, коли X немає. */
export const GH_FOLLOWERS_TOP = 3000;
/** Посилань на роботи для повного балу джерела links. */
export const LINKS_TOP = 10;

export const V7_SOURCE_KEYS = ["gh_eng", "gh_builder", "x", "yt", "onchain", "trading", "site", "links", "audits", "dune",
  "media", "output", "best"] as const;
export type V7Source = (typeof V7_SOURCE_KEYS)[number];
export type V7Sources = Record<V7Source, number | null>;

/** Джерела, з яких складаються ширина й «найсильніше джерело» (без змішаних і Dune: Dune живе в output). */
export const BASE_SOURCES = ["gh_eng", "gh_builder", "x", "yt", "onchain", "trading", "site", "links", "audits"] as const;
type BaseSource = (typeof BASE_SOURCES)[number];

type Maybe<T> = T | null | undefined;

/** Код: як v6, але з командними репозиторіями (засновники, власник 17.09, п.6): їхні зірки й коміти. */
export function srcGhEngV7(g: Maybe<GithubFacts>): number | null {
  if (!g) return null;
  // Засновник комітить у репозиторій компанії напряму, без PR: командні коміти рахуються як робота в чужих проєктах.
  const elsewhere = Math.max(g.mergedPrsElsewhere, g.teamCommits ?? 0);
  return combine([[35, logn(elsewhere, 1000)], [25, logn(g.stars + (g.teamStars ?? 0), 5000)],
    [15, logn(g.reviews12m, 300)], [15, logn(g.followers, 3000)], [10, logn(g.commits12m, 2000)]]);
}

/** X: як v6, верх відомих підписників KOL_TOP. */
export function srcXV7(x: Maybe<XFacts>): number | null {
  if (!x || x.followers === null) return null;
  const per30 = x.daysCovered ? (x.own / Math.max(x.daysCovered, 1)) * 30 : null;
  return combine([[15, logn(x.followers, 500_000)], [30, x.kolSourceGap ? null : logn(x.kol, KOL_TOP)],
    [15, logn(x.ownAvgLikesRt, 1500)], [15, logn(x.ownAvgViews, 150_000)], [15, logn(x.ownAvgReplies, 150)],
    [10, lin(per30, 20)]]);
}

/** Посилання на роботи: лише кількість (власник 17.09, п.4: без перевірки, позначка «додано самостійно»). */
export function srcLinks(l: Maybe<LinksFacts>): number | null {
  if (!l || !(l.count > 0)) return null;
  return 100 * (lin(l.count, LINKS_TOP) ?? 0);
}

/** Репутація 0–100 або null: більше з двох, відомі підписники X або підписники GitHub. */
export function reputation(f: PersonFacts): number | null {
  const x = f.x;
  const fromX = x && x.followers !== null && !x.kolSourceGap && x.kol !== null ? 100 * (logn(x.kol, KOL_TOP) ?? 0) : null;
  const fromGh = f.github ? 100 * (logn(f.github.followers, GH_FOLLOWERS_TOP) ?? 0) : null;
  // v9: більше з двох. До v9 X, коли він був, заміняв GitHub, і інженер, що підключив X з кількома
  // відомими підписниками, втрачав бали. Підключене джерело ніколи не забирає бали.
  return maxOf(fromX, fromGh);
}

export function computeSourcesV7(f: PersonFacts, nowMs: number): V7Sources & { bestOf: BaseSource | null } {
  const w = aggregateWallets(f, nowMs);
  const base: Record<BaseSource, number | null> = {
    gh_eng: srcGhEngV7(f.github), gh_builder: srcGhBuilder(f.github), x: srcXV7(f.x), yt: srcYt(f.youtube),
    onchain: srcOnchain(w), trading: srcTrading(w), site: srcSite(f.site), links: srcLinks(f.links), audits: srcAudits(f.audits),
  };
  const dune = srcDune(f.dune);
  let bestOf: BaseSource | null = null;
  for (const k of BASE_SOURCES) if (base[k] !== null && (bestOf === null || base[k]! > base[bestOf]!)) bestOf = k;
  return {
    ...base, dune,
    media: maxOf(base.x, base.yt),
    output: maxOf(base.site, base.links, base.gh_eng, dune),
    best: bestOf === null ? null : base[bestOf],
    bestOf,
  };
}

type Work = Partial<Record<V7Source, number>>;
export type V7Role = { paths: readonly { label: string; work: Work }[]; anchors: readonly V7Source[] };

const one = (work: Work) => [{ label: Object.keys(work).join("+"), work }] as const;
const GENERAL: V7Role = { paths: one({ best: 40, links: 20 }), anchors: ["best"] };

/** Ролі v7: вага кожного джерела в балах «Роботи» (разом WORK_POINTS). Усі 15 ролей отримують бал. */
export const V7_ROLES: Record<RoleKey, V7Role> = {
  engineer: { paths: one({ gh_eng: 40, gh_builder: 20 }), anchors: ["gh_eng"] },
  security_auditor: {
    paths: [{ label: "audits", work: { audits: 30, gh_eng: 30 } }, { label: "gh_eng", work: { gh_eng: 60 } }],
    anchors: ["audits", "gh_eng"],
  },
  devrel: { paths: one({ media: 30, gh_eng: 30 }), anchors: ["media", "gh_eng"] },
  data_research: { paths: one({ output: 30, x: 30 }), anchors: ["output", "x"] },
  product_manager: { paths: one({ x: 20, gh_builder: 20, output: 20 }), anchors: ["x"] },
  bd: { paths: one({ x: 50, onchain: 10 }), anchors: ["x"] },
  marketing_content: { paths: one({ media: 40, site: 20 }), anchors: ["media"] },
  creator_kol: { paths: one({ media: 60 }), anchors: ["media"] },
  community: { paths: one({ x: 50, onchain: 10 }), anchors: ["x"] },
  trader: { paths: one({ trading: 50, onchain: 10 }), anchors: ["trading"] },
  designer: { paths: one({ links: 40, x: 20 }), anchors: ["links"] },
  operations_support: GENERAL,
  finance: GENERAL,
  legal_compliance: GENERAL,
  hr_recruiting: GENERAL,
};

/** Які базові джерела «зайняті» роботою: вони не повторюються в ширині. */
function usedBy(work: Work, bestOf: BaseSource | null): Set<string> {
  const out = new Set<string>();
  for (const k of Object.keys(work)) {
    if (k === "media") { out.add("x"); out.add("yt"); }
    else if (k === "output") { for (const s of ["site", "links", "gh_eng"]) out.add(s); }
    else if (k === "best") { if (bestOf) out.add(bestOf); }
    else out.add(k);
  }
  return out;
}

export type BreakdownV7 = {
  formula: typeof FORMULA_VERSION;
  sources: V7Sources;
  /** Робота: вага в балах (разом WORK_POINTS). */
  core: Record<string, { weight: number; value: number | null }>;
  /** Репутація (ключ rep, max REP_POINTS) і всі джерела ширини (max WIDTH_EACH кожне, разом WIDTH_MAX). */
  bonus: Record<string, { max: number; value: number | null }>;
  /** Покриття роботи, % від WORK_POINTS. */
  cover: number;
  level: number | null;
  reason: string | null;
  gaps: Record<string, string>;
  layers: { work: number; rep: number; width: number } | null;
  /** Для «best»: яке джерело найсильніше. */
  bestOf: string | null;
  /** Посилання, додані людиною без перевірки. */
  selfAddedLinks: boolean;
};

export type RoleResultV7 = { score: number | null; core: number | null; cover: number; level: number | null; breakdown: BreakdownV7 };
export type PersonScoreV7 = { formula: typeof FORMULA_VERSION; sources: V7Sources; roles: Record<RoleKey, RoleResultV7> };

export function levelOf(score: number): number {
  return Math.min(10, Math.floor(score / 10) + 1);
}
const r1 = (v: number) => Math.round(v * 10) / 10;
const r1n = (v: number | null) => (v === null ? null : r1(v));

function collectGaps(f: PersonFacts): Record<string, string> {
  const gaps: Record<string, string> = {};
  for (const [k, v] of Object.entries(f.gaps ?? {})) if (v) gaps[k] = v;
  if (f.audits?.gap && !gaps.audits) gaps.audits = f.audits.gap;
  if (f.x?.kolSourceGap && !gaps.x) gaps["x.kol"] = "KOL followers unavailable";
  for (const perAddr of Object.values(f.evm ?? {})) {
    for (const [chain, c] of Object.entries(perAddr)) if (c?.gap) gaps[`evm.${chain}`] ??= c.gap;
  }
  const unknown = Object.values(f.solana ?? {}).filter((s) => solanaSwapsKnown(s) === null);
  if (!gaps.solana && unknown.length) {
    gaps.solana = unknown.some((s) => s.sampleSeen < SOLANA_MIN_SAMPLE) ? "sample too small" : "swaps unknown";
  }
  return gaps;
}

function scoreRole(spec: V7Role, s: V7Sources, bestOf: BaseSource | null, rep: number | null,
  shown: V7Sources, gaps: Record<string, string>, selfAddedLinks: boolean): RoleResultV7 {
  const empty = (reason: string, cover: number): RoleResultV7 => ({
    score: null, core: null, cover, level: null,
    breakdown: { formula: FORMULA_VERSION, sources: shown, core: {}, bonus: {}, cover, level: null, reason, gaps, layers: null,
      bestOf, selfAddedLinks },
  });
  if (!spec.anchors.some((a) => s[a] !== null && s[a] !== 0)) {
    return empty(`missing_anchor:${spec.anchors.join(",")}`, 0);
  }

  let best: { total: number; work: number; width: number; cover: number; path: (typeof spec.paths)[number];
    widthKeys: BaseSource[] } | null = null;
  const repPoints = (REP_POINTS * (rep ?? 0)) / 100;
  for (const path of spec.paths) {
    let work = 0, cover = 0;
    for (const [k, w] of Object.entries(path.work) as Array<[V7Source, number]>) {
      work += (w * (s[k] ?? 0)) / 100;
      if (s[k] !== null) cover += w;
    }
    const used = usedBy(path.work, bestOf);
    const widthKeys = BASE_SOURCES.filter((k) => !used.has(k) && s[k] !== null)
      .sort((a, b) => s[b]! - s[a]! || BASE_SOURCES.indexOf(a) - BASE_SOURCES.indexOf(b));
    const width = Math.min(WIDTH_MAX, widthKeys.reduce((sum, k) => sum + (WIDTH_EACH * s[k]!) / 100, 0));
    const total = work + repPoints + width;
    if (!best || total > best.total) best = { total, work, width, cover, path, widthKeys };
  }
  const b = best!;
  const score = r1(Math.min(100, b.total));
  const cover = Math.round((100 * b.cover) / WORK_POINTS);
  const bonus: BreakdownV7["bonus"] = { rep: { max: REP_POINTS, value: r1n(rep) } };
  for (const k of b.widthKeys) bonus[k] = { max: WIDTH_EACH, value: shown[k] };
  return {
    score, core: r1(b.work), cover, level: levelOf(score),
    breakdown: {
      formula: FORMULA_VERSION, sources: shown,
      core: Object.fromEntries(Object.entries(b.path.work).map(([k, w]) => [k, { weight: w, value: shown[k as V7Source] }])),
      bonus, cover, level: levelOf(score),
      reason: spec.paths.length > 1 ? `path:${b.path.label}` : null,
      gaps, layers: { work: r1(b.work), rep: r1(repPoints), width: r1(b.width) }, bestOf, selfAddedLinks,
    },
  };
}

/** Бал 0–100 за кожною з 15 ролей. `nowMs` лише для віку гаманців. */
export function scorePersonV7(facts: PersonFacts, nowMs: number = Date.now()): PersonScoreV7 {
  const { bestOf, ...s } = computeSourcesV7(facts, nowMs);
  const shown = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, r1n(v)])) as V7Sources;
  const gaps = collectGaps(facts);
  const rep = reputation(facts);
  const selfAddedLinks = s.links !== null;
  const roles = {} as Record<RoleKey, RoleResultV7>;
  for (const role of ROLE_ORDER) roles[role] = scoreRole(V7_ROLES[role], s, bestOf, rep, shown, gaps, selfAddedLinks);
  return { formula: FORMULA_VERSION, sources: shown, roles };
}
