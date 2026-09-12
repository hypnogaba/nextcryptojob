// Підставні збирачі для тестів і сухих прогонів: без мережі, з передбачуваними фактами.
import type {
  AuditsFacts, DuneFacts, EvmFacts, GithubFacts, HyperliquidFacts, SiteFacts, SolanaFacts, XFacts, YoutubeFacts,
} from "../types.js";
import type { CollectorCtx, CollectorRegistry, CollectorResult } from "./registry.js";

export type CollectorName = keyof CollectorRegistry;
export type FakeCall = { collector: CollectorName; input: unknown; signal: AbortSignal };
export interface FakeRegistry extends CollectorRegistry {
  readonly calls: FakeCall[];
}

export const sampleX = (): XFacts => ({ followers: 12_000, kol: 40, kolSourceGap: false, fetched: 100, own: 60,
  repliesMade: 40, own30d: 20, ownAvgLikesRt: 90, ownAvgViews: 8_000, ownAvgReplies: 12, daysCovered: 60 });
export const sampleGithub = (): GithubFacts => ({ createdAt: "2016-03-01T00:00:00Z", followers: 300, stars: 900,
  commits12m: 700, reviews12m: 60, mergedPrsElsewhere: 80, reposPushed12m: 9, reposWithSite: 2 });
export const sampleSite = (): SiteFacts => ({ reachable: true, feedItems: 40, items90d: 3, sitemapUrls: 60, latestTs: 1_780_000_000 });
export const sampleYoutube = (): YoutubeFacts => ({ channelId: "UCfake", subscribers: 20_000, hiddenSubscribers: false,
  avgViewsRecent: 3_000, videos90d: 5 });
export const sampleAudits = (): AuditsFacts => ({ earningsUsd: 150_000, high: 20, contests: 15,
  providers: { sherlock: { earningsUsd: 150_000, high: 20, medium: 30, contests: 15 } }, verifiedBy: "github" });
export const sampleDune = (): DuneFacts => ({ spellbookPrs: 30, spellbookPrs12m: 6 });
export const sampleEvm = (addresses: readonly string[]): EvmFacts => Object.fromEntries(addresses.map((a) => [a, {
  ethereum: { sent: 400, sentCapped: false, firstTs: 1_500_000_000, swaps: 50, source: "etherscan" as const },
  base: { sent: 120, sentCapped: false, firstTs: 1_700_000_000, swaps: 30, source: "blockscout" as const },
}]));
export const sampleHyperliquid = (addresses: readonly string[]): HyperliquidFacts =>
  Object.fromEntries(addresses.map((a) => [a, { volumeUsd: 250_000, fillsRecent: 120 }]));
export const sampleSolana = (addresses: readonly string[]): SolanaFacts => Object.fromEntries(addresses.map((a) => [a, {
  sigs: 900, sigsOk: 880, sigsCapped: false, firstTs: 1_650_000_000, sampleSeen: 200, sampleSwaps: 60, swaps: 270 }]));

const ok = <T>(facts: T): CollectorResult<T> => ({ ok: true, facts });

/** Збирач, що чекає, доки його скасують, і тоді кидає AbortError (як справжні). */
export function hangUntilAborted<T>(): (...args: unknown[]) => Promise<CollectorResult<T>> {
  return (...args) => new Promise((_resolve, reject) => {
    const { signal } = args[args.length - 1] as CollectorCtx;
    const fail = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    if (signal.aborted) fail(); else signal.addEventListener("abort", fail, { once: true });
  });
}

/** Збирач, що не зважає на скасування й ніколи не відповідає. */
export function neverResolves<T>(): () => Promise<CollectorResult<T>> {
  return () => new Promise<CollectorResult<T>>(() => undefined);
}

/** Підміна збирача: та сама сигнатура, але вхід довільний (тестам зручно брати hangUntilAborted тощо). */
type Override = (input: never, ...rest: never[]) => unknown;
export type FakeOverrides = { [K in CollectorName]?: CollectorRegistry[K] | Override };

/**
 * Реєстр із типовими фактами для кожного джерела. `over` підміняє окремі збирачі.
 * Кожен виклик пишеться в `calls` (вхід, сигнал).
 */
export function fakeRegistry(over: FakeOverrides = {}): FakeRegistry {
  const calls: FakeCall[] = [];
  const run = async <T>(collector: CollectorName, input: unknown, args: unknown[], fallback: () => CollectorResult<T>):
    Promise<CollectorResult<T>> => {
    const ctx = args[args.length - 1] as CollectorCtx;
    calls.push({ collector, input, signal: ctx.signal });
    const custom = over[collector] as ((...a: unknown[]) => Promise<CollectorResult<T>> | CollectorResult<T>) | undefined;
    return custom ? custom(...args) : fallback();
  };
  return {
    calls,
    collectX: (h, ctx) => run("collectX", h, [h, ctx], () => ok(sampleX())),
    collectGithub: (l, ctx) => run("collectGithub", l, [l, ctx], () => ok(sampleGithub())),
    collectSite: (u, ctx) => run("collectSite", u, [u, ctx], () => ok(sampleSite())),
    collectYoutube: (h, ctx) => run("collectYoutube", h, [h, ctx], () => ok(sampleYoutube())),
    collectAudits: (h, links, ctx) => run("collectAudits", { sherlock: h, ...links }, [h, links, ctx], () => ok(sampleAudits())),
    collectDune: (l, ctx) => run("collectDune", l, [l, ctx], () => ok(sampleDune())),
    collectEvm: (a, ctx) => run("collectEvm", [...a], [a, ctx], () => ok(sampleEvm(a))),
    collectHyperliquid: (a, ctx) => run("collectHyperliquid", [...a], [a, ctx], () => ok(sampleHyperliquid(a))),
    collectSolana: (a, ctx) => run("collectSolana", [...a], [a, ctx], () => ok(sampleSolana(a))),
  };
}
