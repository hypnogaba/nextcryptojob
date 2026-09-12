// Перекладає сирий запис дослідження (research/harness: collect_v3.py, collect_fast.py, sol_sample.py,
// collect_audits.py, collect_dune.py; ключі snake_case) у PersonFacts договору §3.
// Лише для звірки з Python (scripts/parity.ts); у продукті факти пишуть збирачі engine.
import type {
  AuditsFacts, EvmChainFacts, EvmFacts, GithubFacts, HyperliquidFacts, PersonFacts, SolanaFacts, SourceKey,
} from "../src/types.js";

type Err = { _error?: string | null };
type RawX = Err & { followers?: number | null; kol?: number | null; kol_source_gap?: boolean; fetched?: number; own?: number;
  replies_made?: number; own_30d?: number; own_avg_likes_rt?: number | null; own_avg_views?: number | null;
  own_avg_replies?: number | null; days_covered?: number | null };
type RawGh = Err & { createdAt?: string; followers?: number; stars?: number; commits_12m?: number; reviews_12m?: number;
  merged_prs_elsewhere?: number | null; repos_pushed_12m?: number; repos_with_site?: number };
type RawYt = Err & { subscribers?: number | null; avg_views_recent?: number | null; videos_90d?: number | null };
type RawSite = Err & { reachable?: boolean; feed_items?: number; items_90d?: number; sitemap_urls?: number; latest_ts?: number | null };
type RawChain = Err & { sent?: number | null; sent_capped?: boolean; first_ts?: number | null; swaps_est?: number | null; source?: string };
type RawHl = Err & { volume_usd?: number | null; fills_recent?: number | null };
type RawSol = Err & { sigs?: number; sigs_ok?: number; sigs_capped?: boolean; first_ts?: number | null; sample_seen?: number;
  sample_swaps?: number; swaps?: number | null };
type RawAudits = { earnings_usd?: number | null; high?: number | null; contests?: number | null; gap?: string;
  providers?: Record<string, { earnings_usd?: number; high?: number; medium?: number; contests?: number }>;
  platforms?: Record<string, { github?: string; x?: string }> };
type RawDune = Err & { spellbook_prs?: number | null; spellbook_prs_12m?: number | null };

export type RawPerson = { id?: string; x?: RawX; gh?: RawGh; yt?: RawYt; site?: RawSite;
  evm?: Record<string, Record<string, RawChain | RawHl>>; sol?: Record<string, RawSol>; audits?: RawAudits | null; dune?: RawDune | null };
export type RawExtra = { audits?: RawAudits | null; dune?: RawDune | null; gh?: RawGh };

const EVM_CHAINS = ["ethereum", "base", "arbitrum", "optimism"] as const;
const n = (v: number | null | undefined): number | null => (v === undefined ? null : v);

/** Як `merged()` у score_v5.py: audits і dune з raw_extra, GitHub з raw_extra лише замість прогалини. */
function merged(r: RawPerson, e: RawExtra | undefined): RawPerson {
  const out: RawPerson = { ...r };
  if (out.audits == null && e?.audits != null) out.audits = e.audits;
  if (out.dune == null && e?.dune != null) out.dune = e.dune;
  if ((!out.gh || out.gh._error) && e?.gh && !e.gh._error) out.gh = e.gh;
  return out;
}

function need(v: number | null | undefined, what: string): number {
  if (v === null || v === undefined) throw new Error(`${what}: null не вміщується в тип договору`);
  return v;
}

export function adaptHarness(raw: RawPerson, extra?: RawExtra): PersonFacts {
  const r = merged(raw, extra);
  const f: PersonFacts = {};
  const gaps: Partial<Record<SourceKey, string>> = {};

  if (r.x) {
    const x = r.x;
    f.x = { followers: n(x.followers), kol: n(x.kol), kolSourceGap: x.kol_source_gap ?? false, fetched: x.fetched ?? 0,
      own: x.own ?? 0, repliesMade: x.replies_made ?? 0, own30d: x.own_30d ?? 0, ownAvgLikesRt: n(x.own_avg_likes_rt),
      ownAvgViews: n(x.own_avg_views), ownAvgReplies: n(x.own_avg_replies), daysCovered: n(x.days_covered) };
    if (x._error) gaps.x = x._error;
  }

  if (r.gh) {
    if (r.gh._error) { f.github = null; gaps.github = r.gh._error; }
    else {
      const g = r.gh;
      const gh: GithubFacts = { createdAt: g.createdAt ?? "", followers: need(g.followers, "gh.followers"),
        stars: need(g.stars, "gh.stars"), commits12m: need(g.commits_12m, "gh.commits_12m"),
        reviews12m: need(g.reviews_12m, "gh.reviews_12m"), mergedPrsElsewhere: need(g.merged_prs_elsewhere, "gh.merged_prs_elsewhere"),
        reposPushed12m: need(g.repos_pushed_12m, "gh.repos_pushed_12m"), reposWithSite: need(g.repos_with_site, "gh.repos_with_site") };
      f.github = gh;
    }
  }

  if (r.yt) {
    if (r.yt._error) { f.youtube = null; gaps.youtube = r.yt._error; }
    else f.youtube = { channelId: "", subscribers: n(r.yt.subscribers), hiddenSubscribers: r.yt.subscribers == null,
      avgViewsRecent: n(r.yt.avg_views_recent), videos90d: n(r.yt.videos_90d) };
  }

  if (r.site) {
    const s = r.site;
    f.site = { reachable: s.reachable ?? false, feedItems: s.feed_items ?? 0, items90d: s.items_90d ?? 0,
      sitemapUrls: s.sitemap_urls ?? 0, latestTs: n(s.latest_ts) };
  }

  const evmAddrs = Object.entries(r.evm ?? {});
  if (evmAddrs.length) {
    const evm: EvmFacts = {};
    const hl: HyperliquidFacts = {};
    for (const [addr, per] of evmAddrs) {
      const chains: EvmFacts[string] = {};
      for (const ch of EVM_CHAINS) {
        const c = per[ch] as RawChain | undefined;
        if (!c) continue;
        const source: EvmChainFacts["source"] = c.source === "etherscan" ? "etherscan" : "blockscout";
        chains[ch] = c._error
          ? { sent: null, sentCapped: false, firstTs: null, swaps: null, source, gap: c._error }
          : { sent: n(c.sent), sentCapped: c.sent_capped ?? false, firstTs: n(c.first_ts), swaps: n(c.swaps_est), source };
      }
      evm[addr] = chains;
      const h = per.hyperliquid as RawHl | undefined;
      if (h) hl[addr] = h._error ? { volumeUsd: null, fillsRecent: null } : { volumeUsd: n(h.volume_usd), fillsRecent: n(h.fills_recent) };
    }
    f.evm = evm;
    if (Object.keys(hl).length) f.hyperliquid = hl;
  }

  const solAddrs = Object.entries(r.sol ?? {});
  if (solAddrs.length) {
    const sol: SolanaFacts = {};
    for (const [addr, s] of solAddrs) {
      if (s._error) { gaps.solana = s._error; continue; }
      // Без sample_seen (collect_fast.py без вибірки) Python не вважає вибірку замалою.
      sol[addr] = { sigs: s.sigs ?? 0, sigsOk: s.sigs_ok ?? s.sigs ?? 0, sigsCapped: s.sigs_capped ?? false, firstTs: n(s.first_ts),
        sampleSeen: s.sample_seen ?? Number.POSITIVE_INFINITY, sampleSwaps: s.sample_swaps ?? 0, swaps: n(s.swaps) };
    }
    f.solana = Object.keys(sol).length ? sol : null;
  }

  if (r.audits) {
    const a = r.audits;
    const sherlock = a.platforms?.sherlock;
    if (!sherlock && a.earnings_usd == null) { f.audits = null; gaps.audits = a.gap ?? "no verified profile"; }
    else {
      const providers: AuditsFacts["providers"] = {};
      for (const [p, v] of Object.entries(a.providers ?? {})) {
        providers[p] = { earningsUsd: v.earnings_usd ?? 0, high: v.high ?? 0, medium: v.medium ?? 0, contests: v.contests ?? 0 };
      }
      f.audits = { earningsUsd: n(a.earnings_usd), high: n(a.high), contests: n(a.contests), providers,
        verifiedBy: sherlock?.github ? "github" : "x", ...(a.gap ? { gap: a.gap } : {}) };
    }
  }

  if (r.dune) {
    if (r.dune._error) { f.dune = null; gaps.dune = r.dune._error; }
    else f.dune = { spellbookPrs: n(r.dune.spellbook_prs), spellbookPrs12m: n(r.dune.spellbook_prs_12m) };
  }

  if (Object.keys(gaps).length) f.gaps = gaps;
  return f;
}
