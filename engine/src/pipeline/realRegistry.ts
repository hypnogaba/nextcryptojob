// Справжні збирачі src/collectors/ за інтерфейсом конвеєра (registry.ts). Адаптерів не треба:
// реєстр лише перекладає спільний контекст (env, signal, межа збору, годинник) на опції збирача.
import { collectAudits } from "../collectors/audits.js";
import type { CollectorContext } from "../collectors/context.js";
import { collectDune } from "../collectors/dune.js";
import { collectEvm } from "../collectors/evm.js";
import { collectGithub } from "../collectors/github.js";
import { collectHyperliquid } from "../collectors/hyperliquid.js";
import type { CollectOptions } from "../collectors/onchain.js";
import { collectSite } from "../collectors/site.js";
import { collectSolana } from "../collectors/solana.js";
import { collectX } from "../collectors/x.js";
import { collectYoutube } from "../collectors/youtube.js";
import type { CollectorCtx, CollectorRegistry } from "./registry.js";

/** Сирі функції збирачів. Тести підставляють свої, щоб перевірити, що саме отримує кожен. */
export const COLLECTORS = {
  collectX, collectGithub, collectSite, collectYoutube, collectAudits, collectDune,
  collectEvm, collectHyperliquid, collectSolana,
};
export type Collectors = typeof COLLECTORS;

/** Контекст збирачів context.ts (x, github, site, youtube, audits, dune): межа зветься `deadlineAt`. */
export const sourceCtx = (ctx: CollectorCtx): CollectorContext =>
  ({ env: ctx.env, signal: ctx.signal, deadlineAt: ctx.deadline, now: ctx.now });

/**
 * Опції збирачів гаманців (onchain.ts): межа зветься `deadline`. Без неї кожен гаманець рахував би
 * свої 45 с від власного старту, а не від старту людини, і міг би не встигнути віддати виміряне.
 * Кеш селекторів EVM береться з env.SELECTOR_CACHE (selectors.ts).
 */
export const walletOpts = (ctx: CollectorCtx): CollectOptions =>
  ({ env: ctx.env, signal: ctx.signal, deadline: ctx.deadline, now: ctx.now });

export function createRealRegistry(c: Collectors = COLLECTORS): CollectorRegistry {
  return {
    collectX: (handle, ctx) => c.collectX(handle, sourceCtx(ctx)),
    collectGithub: (login, ctx) => c.collectGithub(login, sourceCtx(ctx)),
    collectSite: (url, ctx) => c.collectSite(url, sourceCtx(ctx)),
    collectYoutube: (handle, ctx) => c.collectYoutube(handle, sourceCtx(ctx)),
    collectAudits: (handle, links, ctx) => c.collectAudits(handle, links, sourceCtx(ctx)),
    collectDune: (login, ctx) => c.collectDune(login, sourceCtx(ctx)),
    collectEvm: (addresses, ctx) => c.collectEvm(addresses, walletOpts(ctx)),
    collectHyperliquid: (addresses, ctx) => c.collectHyperliquid(addresses, walletOpts(ctx)),
    collectSolana: (addresses, ctx) => c.collectSolana(addresses, walletOpts(ctx)),
  };
}
