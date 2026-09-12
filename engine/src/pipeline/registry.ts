// Інтерфейс збирачів для конвеєра. Самі збирачі живуть у src/collectors/; конвеєр бачить
// їх лише через CollectorRegistry, тож тести підставляють fakeRegistry, а продукт realRegistry.
import type {
  AuditsFacts, Collected, DuneFacts, EvmFacts, GithubFacts, HyperliquidFacts, SiteFacts, SolanaFacts, XFacts, YoutubeFacts,
} from "../types.js";

/** Змінні оточення (docs/contracts.md §6). Ключа немає → збирач дає прогалину `not configured: <KEY>`. */
export type EngineEnv = Readonly<Record<string, string | undefined>>;

/**
 * Що отримує кожен збирач. `signal` спрацьовує на дедлайні людини або при зупинці процесу;
 * збирач має кинути AbortError (прогалину за скасований збір пише конвеєр, а не збирач).
 * `deadline` каже збирачам наперед, коли спрацює `signal` через дедлайн: повтори й сторінки,
 * що не встигнуть, вони не починають, а гаманці віддають виміряне раніше за обрив.
 */
export interface CollectorCtx {
  env: EngineEnv;
  signal: AbortSignal;
  /** Межа збору людини, мс за годинником `now`: старт збору + ENGINE_DEADLINE_MS. */
  deadline: number;
  /** Годинник, мс (Date.now у продукті). */
  now: () => number;
}

/**
 * Для collectAudits: з чим звіряти профіль Sherlock (договір §2). Лише підтверджені GitHub і X:
 * чужий нік, вписаний без доказу, не має відмикати чужий заробіток на Sherlock.
 */
export interface AuditLinks {
  github: string | null;
  x: string | null;
}

export interface CollectorRegistry {
  collectX(handle: string, ctx: CollectorCtx): Promise<Collected<XFacts>>;
  collectGithub(login: string, ctx: CollectorCtx): Promise<Collected<GithubFacts>>;
  collectSite(url: string, ctx: CollectorCtx): Promise<Collected<SiteFacts>>;
  collectYoutube(handle: string, ctx: CollectorCtx): Promise<Collected<YoutubeFacts>>;
  collectAudits(sherlockHandle: string, links: AuditLinks, ctx: CollectorCtx): Promise<Collected<AuditsFacts>>;
  collectDune(githubLogin: string, ctx: CollectorCtx): Promise<Collected<DuneFacts>>;
  collectEvm(addresses: readonly string[], ctx: CollectorCtx): Promise<Collected<EvmFacts>>;
  collectHyperliquid(addresses: readonly string[], ctx: CollectorCtx): Promise<Collected<HyperliquidFacts>>;
  collectSolana(addresses: readonly string[], ctx: CollectorCtx): Promise<Collected<SolanaFacts>>;
}
