// Інтерфейс збирачів для конвеєра. Самі збирачі живуть у src/collectors/ (інші доріжки);
// конвеєр бачить їх лише через CollectorRegistry, тож тести підставляють fakeRegistry,
// а продукт отримає realRegistry після злиття гілок.
import type {
  AuditsFacts, DuneFacts, EvmFacts, Fetched, GithubFacts, HyperliquidFacts, SiteFacts, SolanaFacts, XFacts, YoutubeFacts,
} from "../types.js";

/** Змінні оточення (docs/contracts.md §6). Ключа немає → збирач дає прогалину `not configured: <KEY>`. */
export type EngineEnv = Readonly<Record<string, string | undefined>>;

/**
 * Що отримує кожен збирач. `signal` спрацьовує на дедлайні людини або при зупинці процесу;
 * збирач має кинути AbortError (прогалину за скасований збір пише конвеєр, а не збирач).
 */
export interface CollectorCtx {
  env: EngineEnv;
  signal: AbortSignal;
}

/**
 * Результат збирача. `partial` дають збирачі гаманців: адреси, що не відповіли, коли інші
 * відповіли. У фактах їх немає; конвеєр показує їх у підсумку, але не в gap_reason.
 */
export type CollectorResult<T> = Fetched<T> & { partial?: Record<string, string> };

/** Для collectAudits: з чим звіряти профіль Sherlock (договір §2). */
export interface AuditLinks {
  github: string | null;
  x: string | null;
}

export interface CollectorRegistry {
  collectX(handle: string, ctx: CollectorCtx): Promise<CollectorResult<XFacts>>;
  collectGithub(login: string, ctx: CollectorCtx): Promise<CollectorResult<GithubFacts>>;
  collectSite(url: string, ctx: CollectorCtx): Promise<CollectorResult<SiteFacts>>;
  collectYoutube(handle: string, ctx: CollectorCtx): Promise<CollectorResult<YoutubeFacts>>;
  collectAudits(sherlockHandle: string, links: AuditLinks, ctx: CollectorCtx): Promise<CollectorResult<AuditsFacts>>;
  collectDune(githubLogin: string, ctx: CollectorCtx): Promise<CollectorResult<DuneFacts>>;
  collectEvm(addresses: readonly string[], ctx: CollectorCtx): Promise<CollectorResult<EvmFacts>>;
  collectHyperliquid(addresses: readonly string[], ctx: CollectorCtx): Promise<CollectorResult<HyperliquidFacts>>;
  collectSolana(addresses: readonly string[], ctx: CollectorCtx): Promise<CollectorResult<SolanaFacts>>;
}
