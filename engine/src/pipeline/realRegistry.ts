import type { CollectorRegistry } from "./registry.js";

/**
 * TODO(controller, після злиття track/engine-collect-a і track/engine-collect-b):
 * під'єднати справжні збирачі з src/collectors/ і прибрати цей виняток.
 *
 *   collectX, collectGithub, collectSite, collectYoutube, collectAudits, collectDune  (collect-a)
 *   collectEvm, collectHyperliquid, collectSolana                                      (collect-b)
 *
 * Кожен приймає контекст `{ env, signal }` (registry.ts, CollectorCtx) і повертає Fetched<Facts>.
 * Збирачі гаманців беруть опції другим аргументом: `collectEvm(addrs, { env: ctx.env, signal: ctx.signal })`.
 *
 * Поки це заглушка: worker, score-user і quality-gate падають одразу з ясною причиною,
 * а не ставлять кожне завдання в чергу тричі й позначають failed.
 */
export function createRealRegistry(): CollectorRegistry {
  throw new Error("collectors not wired: src/pipeline/realRegistry.ts ще заглушка (див. TODO у файлі)");
}
