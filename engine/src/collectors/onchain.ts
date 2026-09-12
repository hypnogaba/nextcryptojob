/**
 * Спільне для збирачів гаманців (evm, hyperliquid, solana).
 */
import type { Fetched } from "../types.js";

export type Env = Record<string, string | undefined>;

export interface CollectOptions {
  /** Підміна fetch для тестів; тоді safeFetch не ходить у DNS. */
  fetchImpl?: typeof fetch;
  /** Джерело ключів. Типово process.env. */
  env?: Env;
  /** Скасування всього збору. */
  signal?: AbortSignal;
  /** Повтори fetchJson на 5xx і мережевих збоях. */
  retries?: number;
  /** Пауза між повторами fetchJson, мс. */
  retryDelayMs?: number;
  /** Пауза для бюджету після ліміту, про який джерело каже в тілі (200 + "rate limit"), мс. */
  rateLimitBackoffMs?: number;
}

/**
 * Результат збирача гаманців. `partial`: адреси, які не відповіли зовсім,
 * коли інші відповіли: у фактах їх немає, а нуль замість них був би вигадкою.
 * Сумісний із Fetched<T>.
 */
export type Collected<T> = Fetched<T> & { partial?: Record<string, string> };

export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** Прибирає значення ключа з тексту, якщо чуже повідомлення його повторило. */
export function scrubKey(text: string, key: string | undefined): string {
  if (!key) return text;
  return text.split(key).join("***").split(encodeURIComponent(key)).join("***");
}

/** Скільки разів перечікувати ліміт, про який джерело каже в тілі відповіді. */
export const IN_BAND_RETRIES = 5;

/** Зростаюча пауза після ліміту в тілі: base, 2·base, 4·base… */
export const inBandDelay = (base: number, attempt: number): number => base * 2 ** attempt;

/** Пул: не більше n задач одночасно, порядок результатів як у входу. */
export async function mapPool<T, R>(items: readonly T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}

export const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
export const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** EVM-адреси за §2: нижній регістр, без повторів, лише правильного формату. */
export function normEvm(addresses: readonly string[]): { valid: string[]; invalid: string[] } {
  const valid = new Set<string>();
  const invalid: string[] = [];
  for (const a of addresses) {
    const v = a.trim().toLowerCase();
    if (EVM_ADDRESS.test(v)) valid.add(v); else invalid.push(a);
  }
  return { valid: [...valid], invalid };
}
