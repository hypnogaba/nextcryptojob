// Збір фактів однієї людини: усі доречні збирачі паралельно, спільний дедлайн.
// Спільне для scoreUser (run-person.ts) і воріт якості (quality-gate.ts).
import type { Fetched, PersonFacts, SourceKey } from "../types.js";
import { shortError } from "./errors.js";
import { type CollectorInputs, plannedSources } from "./identities.js";
import type { CollectorCtx, CollectorRegistry, CollectorResult, EngineEnv } from "./registry.js";

export const DEFAULT_DEADLINE_MS = 45_000;
/** Прогалина джерела, яке не встигло до дедлайну. Завдання від неї не падає. */
export const TIMEOUT_GAP = "timeout";
/** X без підтвердження не рахується (договір §2), але людина бачить, чому. */
export const NOT_VERIFIED_GAP = "not verified";

export type SourceOutcome = {
  result: Fetched<unknown>;
  /** Скільки мс ішов збирач (до відповіді або до дедлайну). */
  ms: number;
  /** Гаманці: адреси без відповіді, коли інші відповіли. */
  partial?: Record<string, string>;
};

export type Outcomes = Partial<Record<SourceKey, SourceOutcome>>;

export interface CollectOptions {
  registry: CollectorRegistry;
  env: EngineEnv;
  /** Зовнішнє скасування (зупинка процесу). На відміну від дедлайну, кидає, а не пише прогалини. */
  signal?: AbortSignal;
  deadlineMs?: number;
  /** Лише ці джерела (ворота якості збирають те, чого немає в кеші). */
  only?: readonly SourceKey[];
}

class DeadlineError extends Error {
  override name = "TimeoutError";
}

function call(source: SourceKey, i: CollectorInputs, r: CollectorRegistry, ctx: CollectorCtx): Promise<CollectorResult<unknown>> {
  switch (source) {
    case "x": return r.collectX(i.x!.handle, ctx);
    case "github": return r.collectGithub(i.github!, ctx);
    case "dune": return r.collectDune(i.github!, ctx);
    case "youtube": return r.collectYoutube(i.youtube!, ctx);
    case "site": return r.collectSite(i.site!, ctx);
    case "evm": return r.collectEvm(i.evm, ctx);
    case "hyperliquid": return r.collectHyperliquid(i.evm, ctx);
    case "solana": return r.collectSolana(i.solana, ctx);
    // Профіль Sherlock звіряється лише з підтвердженим X: чужий нік X не має відмикати чужий заробіток.
    case "audits": return r.collectAudits(i.sherlock!, { github: i.github, x: i.x?.verified ? i.x.handle : null }, ctx);
  }
}

/** Відповідь збирача, якій можна вірити: факти-об'єкт або прогалина-рядок. Решта сміття не пишеться. */
function checked(v: CollectorResult<unknown> | undefined): SourceOutcome["result"] & { partial?: Record<string, string> } {
  if (v && v.ok === true && v.facts !== null && typeof v.facts === "object") return v;
  if (v && v.ok === false && typeof v.gap === "string" && v.gap.trim() !== "") return { ok: false, gap: v.gap.slice(0, 300) };
  return { ok: false, gap: "invalid collector result" };
}

/**
 * Запускає збирачі людини паралельно. На дедлайні кожен отримує abort, а його джерело
 * стає прогалиною "timeout"; на відповідь, що забарилась, не чекаємо. Виняток збирача
 * (не мав би статись, збирачі повертають прогалину) теж стає прогалиною.
 * Зовнішній `signal` (зупинка) кидає свою причину: за перерваний збір нічого не пишемо.
 */
export async function collectPerson(inputs: CollectorInputs, o: CollectOptions): Promise<{ outcomes: Outcomes; ms: number }> {
  o.signal?.throwIfAborted();
  const deadlineMs = o.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DeadlineError(`deadline ${deadlineMs} ms`)), deadlineMs);
  const signal = o.signal ? AbortSignal.any([o.signal, deadline.signal]) : deadline.signal;
  const stopped = new Promise<{ kind: "stopped" }>((resolve) => {
    signal.addEventListener("abort", () => resolve({ kind: "stopped" }), { once: true });
  });
  const ctx: CollectorCtx = { env: o.env, signal };
  const planned = plannedSources(inputs).filter((s) => !o.only || o.only.includes(s));
  const t0 = performance.now();

  try {
    const entries = await Promise.all(planned.map(async (source): Promise<[SourceKey, SourceOutcome]> => {
      if (source === "x" && !inputs.x!.verified) return [source, { result: { ok: false, gap: NOT_VERIFIED_GAP }, ms: 0 }];
      const start = performance.now();
      const running = Promise.resolve()
        .then(() => call(source, inputs, o.registry, ctx))
        .then((r) => ({ kind: "done" as const, r }), (e: unknown) => ({ kind: "error" as const, e }));
      const settled = await Promise.race([running, stopped]);
      const ms = Math.round(performance.now() - start);
      if (settled.kind === "stopped" || signal.aborted) return [source, { result: { ok: false, gap: TIMEOUT_GAP }, ms }];
      if (settled.kind === "error") return [source, { result: { ok: false, gap: `error: ${shortError(settled.e, 160)}` }, ms }];
      const { partial, ...result } = checked(settled.r);
      return [source, { result, ms, ...(result.ok && partial && Object.keys(partial).length ? { partial } : {}) }];
    }));
    // Зупинка процесу, а не дедлайн: прогалини "timeout" тут були б неправдою.
    if (o.signal?.aborted) throw o.signal.reason;
    return { outcomes: Object.fromEntries(entries) as Outcomes, ms: Math.round(performance.now() - t0) };
  } finally {
    clearTimeout(timer);
  }
}

/** Факти для формули: відповіли → факти, прогалина → null і причина в `gaps`. */
export function toPersonFacts(outcomes: Outcomes): PersonFacts {
  const facts: Record<string, unknown> = {};
  const gaps: Partial<Record<SourceKey, string>> = {};
  for (const [source, out] of Object.entries(outcomes) as Array<[SourceKey, SourceOutcome]>) {
    if (out.result.ok) facts[source] = out.result.facts;
    else { facts[source] = null; gaps[source] = out.result.gap; }
  }
  return { ...(facts as PersonFacts), ...(Object.keys(gaps).length ? { gaps } : {}) };
}
