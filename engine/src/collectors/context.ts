import { SourceUnavailableError, type FetchOptions, type Lookup } from "../http.js";
import type { Fetched } from "../types.js";

/**
 * Що отримує кожен збирач. Мережа йде лише через safeFetch (http.ts), бюджет запитів
 * бере сам safeFetch; збирачі limiter.run не викликають.
 */
export interface CollectorContext {
  /** Змінні оточення (docs/contracts.md §6). Ключа немає → прогалина `not configured: <KEY>`. */
  env: Readonly<Record<string, string | undefined>>;
  /** Скасування всього збору людини. Скасований збір кидає AbortError, а не пише прогалину. */
  signal?: AbortSignal;
  /**
   * Коли спрацює дедлайн людини (ENGINE_DEADLINE_MS), мс за годинником `now`. Повтори, що не
   * встигнуть до нього, збирачі не починають. Без поля дедлайн невідомий і не обмежує.
   */
  deadlineAt?: number;
  /** Лише тести: fetch під safeFetch (обмежувач і маскування ключів лишаються). */
  fetchImpl?: typeof fetch;
  /** Лише тести: DNS для перевірки хоста разом із fetchImpl. */
  lookup?: Lookup | null;
  /** Годинник, мс. Типово Date.now. */
  now?: () => number;
  /** Пауза між запитами до одного джерела. Типово setTimeout, що зважає на signal. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Причина прогалини, яку збирач кидає зсередини і яка стає `{ ok: false, gap }`. */
export class GapError extends Error {
  override name = "GapError";
}

export const notConfigured = (key: string): GapError => new GapError(`not configured: ${key}`);

/** Параметри safeFetch / fetchJson із контексту збирача. */
export function fetchOpts(ctx: CollectorContext, extra: FetchOptions = {}): FetchOptions {
  return {
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    ...(ctx.lookup !== undefined ? { lookup: ctx.lookup } : {}),
    ...extra,
  };
}

export const nowMs = (ctx: CollectorContext): number => (ctx.now ?? Date.now)();

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = (): void => { clearTimeout(t); reject(signal!.reason); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Чи встигне дія тривалістю ms до дедлайну людини. */
export const fitsDeadline = (ctx: CollectorContext, ms: number): boolean =>
  ctx.deadlineAt === undefined || nowMs(ctx) + ms <= ctx.deadlineAt;

export const pause = (ctx: CollectorContext, ms: number): Promise<void> =>
  (ctx.sleep ?? abortableSleep)(ms, ctx.signal);

/** Коротко про помилку для gap_reason: статус або текст (http.ts уже замаскував ключі). */
export function describeError(e: unknown): string {
  if (e instanceof SourceUnavailableError && e.status) return `HTTP ${e.status}`;
  const msg = e instanceof Error ? e.message : String(e);
  return msg.length > 160 ? `${msg.slice(0, 157)}...` : msg;
}

/**
 * Обгортка збирача: GapError і недоступне джерело стають прогалиною з префіксом джерела,
 * скасування викликачем летить далі (прогалину за скасований збір не пишемо).
 */
export async function collect<T>(source: string, ctx: CollectorContext, run: () => Promise<T>): Promise<Fetched<T>> {
  try {
    return { ok: true, facts: await run() };
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    if (e instanceof GapError) {
      return { ok: false, gap: e.message.startsWith("not configured:") ? e.message : `${source}: ${e.message}` };
    }
    return { ok: false, gap: `${source}: ${describeError(e)}` };
  }
}

/** Порожня відповідь: null, undefined, [] або {}. */
export const isEmpty = (v: unknown): boolean =>
  v == null || (Array.isArray(v) ? v.length === 0 : typeof v === "object" && Object.keys(v).length === 0);

export const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

export const DAY_MS = 86_400_000;
