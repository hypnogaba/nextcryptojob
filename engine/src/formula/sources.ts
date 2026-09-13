// Бали джерел 0–100 (docs/contracts.md §4, формула v6). Джерело без фактів = null, ніколи 0.
import type { AuditsFacts, DuneFacts, GithubFacts, PersonFacts, SiteFacts, XFacts, YoutubeFacts } from "../types.js";
import { combine, lin, logn, maxOf } from "./math.js";
import { aggregateWallets, type WalletSummary } from "./wallets.js";

export const SOURCE_KEYS = ["gh_eng", "gh_builder", "x", "yt", "onchain", "trading", "site", "audits", "dune",
  "media", "output"] as const;
export type ScoreSource = (typeof SOURCE_KEYS)[number];
export type Sources = Record<ScoreSource, number | null>;

type Maybe<T> = T | null | undefined;

export function srcGhEng(g: Maybe<GithubFacts>): number | null {
  if (!g) return null;
  return combine([[35, logn(g.mergedPrsElsewhere, 1000)], [25, logn(g.stars, 5000)], [15, logn(g.reviews12m, 300)],
    [15, logn(g.followers, 3000)], [10, logn(g.commits12m, 2000)]]);
}

export function srcGhBuilder(g: Maybe<GithubFacts>): number | null {
  if (!g) return null;
  return combine([[40, lin(g.reposPushed12m, 12)], [30, lin(g.reposWithSite, 4)], [30, logn(g.commits12m, 1500)]]);
}

export function srcX(x: Maybe<XFacts>): number | null {
  if (!x || x.followers === null) return null;
  // Частота власних постів за 30 днів; без покриття днів вона невідома (як у score_v4.py).
  const per30 = x.daysCovered ? (x.own / Math.max(x.daysCovered, 1)) * 30 : null;
  return combine([[15, logn(x.followers, 500_000)], [30, x.kolSourceGap ? null : logn(x.kol, 1000)],
    [15, logn(x.ownAvgLikesRt, 1500)], [15, logn(x.ownAvgViews, 150_000)], [15, logn(x.ownAvgReplies, 150)],
    [10, lin(per30, 20)]]);
}

export function srcYt(y: Maybe<YoutubeFacts>): number | null {
  if (!y || y.subscribers === null) return null;
  return combine([[45, logn(y.subscribers, 1_000_000)], [35, logn(y.avgViewsRecent, 100_000)], [20, lin(y.videos90d, 12)]]);
}

export function srcOnchain(w: WalletSummary | null): number | null {
  if (!w) return null;
  return combine([[35, lin(w.ageYears, 6)], [35, logn(w.tx, 10_000)], [30, lin(w.chains.length, 6)]]);
}

/**
 * v6: розмір замість широти. Угоди до 10 000 (стеля збирачів), обсяг Hyperliquid до $1 млрд (рівень топів),
 * мережі угод до 6 (усі мережі збирача). `held` прибрано: null у combine ділив решту на 85 замість 100.
 */
export function srcTrading(w: WalletSummary | null): number | null {
  if (!w) return null;
  if (w.trades === 0) return w.tradeGap ? null : 0;
  return combine([[60, logn(w.trades, 10_000)], [10, lin(w.tradeChains.length, 6)], [30, logn(w.hlVolume, 1_000_000_000)]]);
}

/**
 * Сайт, що відповідає, уже доказ (30); тексти додають до 70.
 * Ваги 40/20/10 як у score_v4.py; договір §4 пише 25 для items90d (див. звіт E2).
 */
export function srcSite(s: Maybe<SiteFacts>): number | null {
  if (!s || !s.reachable) return null;
  return 30 + 0.7 * (combine([[40, logn(s.feedItems, 100)], [20, lin(s.items90d, 8)], [10, logn(s.sitemapUrls, 150)]]) ?? 0);
}

/** v5. Заробіток у тисячах доларів: $1M+ і 150 High = вершина. Без доказу (gap) → null. */
export function srcAudits(a: Maybe<AuditsFacts>): number | null {
  if (!a || a.gap || a.earningsUsd === null) return null;
  return combine([[60, logn(a.earningsUsd / 1000, 1000)], [40, logn(a.high, 150)]]);
}

/** v5. Злиті PR у duneanalytics/spellbook; 0 PR → null (нема доказу, а не слабкий аналітик). */
export function srcDune(d: Maybe<DuneFacts>): number | null {
  if (!d || !d.spellbookPrs) return null;
  return combine([[70, logn(d.spellbookPrs, 300)], [30, logn(d.spellbookPrs12m, 50)]]);
}

export function computeSources(f: PersonFacts, nowMs: number): Sources {
  const w = aggregateWallets(f, nowMs);
  const x = srcX(f.x), yt = srcYt(f.youtube), site = srcSite(f.site), ghEng = srcGhEng(f.github), dune = srcDune(f.dune);
  return {
    gh_eng: ghEng, gh_builder: srcGhBuilder(f.github), x, yt, onchain: srcOnchain(w), trading: srcTrading(w), site,
    audits: srcAudits(f.audits), dune, media: maxOf(x, yt), output: maxOf(site, ghEng, dune),
  };
}
