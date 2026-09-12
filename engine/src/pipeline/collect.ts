// Збір фактів однієї людини: усі доречні збирачі паралельно, спільний дедлайн.
// Спільне для scoreUser (run-person.ts) і воріт якості (quality-gate.ts).
import type { Collected, Fetched, PersonFacts, SourceKey } from "../types.js";
import { shortError } from "./errors.js";
import { type CollectorInputs, plannedSources } from "./identities.js";
import type { CollectorCtx, CollectorRegistry, EngineEnv } from "./registry.js";

export const DEFAULT_DEADLINE_MS = 45_000;
/** Прогалина джерела, яке не встигло до дедлайну. Завдання від неї не падає. */
export const TIMEOUT_GAP = "timeout";
/** X без підтвердження не рахується (договір §2), але людина бачить, чому. */
export const NOT_VERIFIED_GAP = "not verified";

export type SourceOutcome = {
  result: Fetched<unknown>;
  /** Скільки мс ішов збирач (до відповіді або до дедлайну). */
  ms: number;
  /** Гаманці: примітки за адресою, коли джерело відповіло не повністю (факти в `result` лишаються). */
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
  /** Годинник для межі збору (`ctx.deadline`), мс. Типово Date.now. */
  now?: () => number;
}

class DeadlineError extends Error {
  override name = "TimeoutError";
}

/**
 * З чим звіряти профіль Sherlock: лише підтверджені GitHub і X (договір §2). Неперевірений GitHub
 * рахується як GitHub, але Sherlock не підтверджує: інакше чужий логін, вписаний без коду в біо,
 * відмикав би чужий заробіток.
 */
export function auditLinks(i: CollectorInputs): { github: string | null; x: string | null } {
  return { github: i.github?.verified ? i.github.login : null, x: i.x?.verified ? i.x.handle : null };
}

function call(source: SourceKey, i: CollectorInputs, r: CollectorRegistry, ctx: CollectorCtx): Promise<Collected<unknown>> {
  switch (source) {
    case "x": return r.collectX(i.x!.handle, ctx);
    case "github": return r.collectGithub(i.github!.login, ctx);
    case "dune": return r.collectDune(i.github!.login, ctx);
    case "youtube": return r.collectYoutube(i.youtube!, ctx);
    case "site": return r.collectSite(i.site!, ctx);
    case "evm": return r.collectEvm(i.evm, ctx);
    case "hyperliquid": return r.collectHyperliquid(i.evm, ctx);
    case "solana": return r.collectSolana(i.solana, ctx);
    case "audits": return r.collectAudits(i.sherlock!, auditLinks(i), ctx);
  }
}

/** Відповідь збирача, якій можна вірити: факти-об'єкт або прогалина-рядок. Решта сміття не пишеться. */
function checked(v: Collected<unknown> | undefined): Collected<unknown> {
  if (v && v.ok === true && v.facts !== null && typeof v.facts === "object") {
    const partial = cleanPartial(v.partial);
    return { ok: true, facts: v.facts, ...(partial ? { partial } : {}) };
  }
  if (v && v.ok === false && typeof v.gap === "string" && v.gap.trim() !== "") return { ok: false, gap: v.gap.slice(0, 300) };
  return { ok: false, gap: "invalid collector result" };
}

/** Лише рядкові примітки, коротко; порожнє → undefined. */
function cleanPartial(p: unknown): Record<string, string> | undefined {
  if (!p || typeof p !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p)) if (typeof v === "string" && v.trim() !== "") out[k] = v.slice(0, 300);
  return Object.keys(out).length ? out : undefined;
}

/** Скільки символів адреси показувати в ключі прогалини: досить розрізнити адреси людини. */
export const ADDRESS_PREFIX = 8;
const short = (address: string): string => address.trim().slice(0, ADDRESS_PREFIX);

/** Примітки `partial` як прогалини частин джерела: `solana.BGjMfx96` → причина (однакові початки зливаються). */
export function partialGaps(source: SourceKey, partial: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [address, note] of Object.entries(partial ?? {})) {
    const k = `${source}.${short(address)}`;
    out[k] = out[k] ? `${out[k]}; ${note}` : note;
  }
  return out;
}

/**
 * `source_facts.gap_reason` для джерела, що дало факти лише частково: "partial: BGjMfx96: <причина>; …".
 * Факти пишуться як є; null, якщо приміток немає.
 */
export function partialReason(partial: Record<string, string> | undefined): string | null {
  const parts = Object.entries(partial ?? {}).map(([address, note]) => `${short(address)}: ${note}`);
  return parts.length ? `partial: ${parts.join("; ")}`.slice(0, 300) : null;
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
  const now = o.now ?? Date.now;
  // Межа, яку бачать збирачі, та сама, що в таймера вище: старт збору + deadlineMs.
  const ctx: CollectorCtx = { env: o.env, signal, deadline: now() + deadlineMs, now };
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
      return [source, { result: result as Fetched<unknown>, ms, ...(partial ? { partial } : {}) }];
    }));
    // Зупинка процесу, а не дедлайн: прогалини "timeout" тут були б неправдою.
    if (o.signal?.aborted) throw o.signal.reason;
    return { outcomes: Object.fromEntries(entries) as Outcomes, ms: Math.round(performance.now() - t0) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Факти для формули: відповіли → факти, прогалина → null і причина в `gaps`.
 * Часткова відповідь гаманців: факти лишаються, а примітки адрес ідуть у `gaps` як `<джерело>.<адреса…>`.
 */
export function toPersonFacts(outcomes: Outcomes): PersonFacts {
  const facts: Record<string, unknown> = {};
  const gaps: Record<string, string> = {};
  for (const [source, out] of Object.entries(outcomes) as Array<[SourceKey, SourceOutcome]>) {
    if (out.result.ok) {
      facts[source] = out.result.facts;
      Object.assign(gaps, partialGaps(source, out.partial));
    } else { facts[source] = null; gaps[source] = out.result.gap; }
  }
  return { ...(facts as PersonFacts), ...(Object.keys(gaps).length ? { gaps } : {}) };
}
