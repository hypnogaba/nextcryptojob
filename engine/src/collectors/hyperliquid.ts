/**
 * Збирач Hyperliquid: обсяг за весь час і кількість останніх угод.
 * Перенесено з research/harness/collect_v3.py (collect_hl) з правкою: якщо portfolio
 * не відповів або не має allTime, обсяг null (Python писав 0), а причина йде в partial.
 *
 * Публічний info API без ключа: POST https://api.hyperliquid.xyz/info
 * {type:"portfolio"|"userFills", user}. portfolio = [[період, {vlm, …}], …];
 * userFills = масив останніх угод (API віддає не більше 2000).
 */
import { fetchJson } from "../http.js";
import type { HyperliquidFacts } from "../types.js";
import {
  addNote, budgetFor, type CollectOptions, type Collected, errText, normEvm, REQUEST_RETRIES, REQUEST_TIMEOUT_MS, STOPPED_EARLY,
} from "./onchain.js";

export const HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info";

async function info<T>(type: "portfolio" | "userFills", user: string, o: CollectOptions, signal: AbortSignal): Promise<T> {
  return fetchJson<T>(HYPERLIQUID_INFO, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, user }),
    signal,
  }, { fetchImpl: o.fetchImpl, retries: o.retries ?? REQUEST_RETRIES, retryDelayMs: o.retryDelayMs, timeoutMs: REQUEST_TIMEOUT_MS });
}

/** allTime.vlm з відповіді portfolio; null, якщо його немає або це не число. */
export function allTimeVolume(portfolio: unknown): number | null {
  if (!Array.isArray(portfolio)) return null;
  for (const entry of portfolio) {
    if (!Array.isArray(entry) || entry[0] !== "allTime") continue;
    const vlm = (entry[1] as { vlm?: unknown } | undefined)?.vlm;
    if (vlm === undefined || vlm === null || vlm === "") return null;
    const n = Number(vlm);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
}

/**
 * Hyperliquid-факти для EVM-адрес людини. Кожне поле, яке не вдалося взяти (запит не
 * відповів, у portfolio немає allTime, userFills не масив), стає null і має пояснення
 * в `partial` ("portfolio: …", "userFills: …"). Якщо в жодної адреси немає жодного
 * поля, повертає прогалину.
 */
export async function collectHyperliquid(addresses: readonly string[], o: CollectOptions = {}): Promise<Collected<HyperliquidFacts>> {
  const { valid, invalid } = normEvm(addresses);
  if (valid.length === 0) return invalid.length ? { ok: false, gap: "no valid EVM address" } : { ok: true, facts: {} };

  const b = budgetFor(o);
  const facts: HyperliquidFacts = {};
  const partial: Record<string, string> = {};
  for (const a of invalid) partial[a] = "not an EVM address";
  let anyOk = false;
  const reasons = new Set<string>();

  await Promise.all(valid.map(async (address) => {
    const [p, f] = await Promise.allSettled([
      info<unknown>("portfolio", address, o, b.signal),
      info<unknown>("userFills", address, o, b.signal),
    ]);
    if (o.signal?.aborted) throw o.signal.reason;
    const why = (r: PromiseRejectedResult): string => (b.stopped() ? STOPPED_EARLY : errText(r.reason));
    const volumeUsd = p.status === "fulfilled" ? allTimeVolume(p.value) : null;
    const fillsRecent = f.status === "fulfilled" && Array.isArray(f.value) ? f.value.length : null;
    facts[address] = { volumeUsd, fillsRecent };
    const notes: string[] = [];
    if (volumeUsd === null) notes.push(`portfolio: ${p.status === "rejected" ? why(p) : "no allTime volume"}`);
    if (fillsRecent === null) notes.push(`userFills: ${f.status === "rejected" ? why(f) : "not a list"}`);
    for (const n of notes) addNote(partial, address, n);
    if (volumeUsd !== null || fillsRecent !== null) anyOk = true;
    else reasons.add(notes.join("; "));
  }));

  if (!anyOk) return { ok: false, gap: `Hyperliquid: ${[...reasons].join("; ").slice(0, 400)}` };
  return { ok: true, facts, ...(Object.keys(partial).length ? { partial } : {}) };
}
