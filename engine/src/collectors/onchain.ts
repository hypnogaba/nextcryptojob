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
  /**
   * Межа збору людини, мс за годинником `now`. Типово now() + ENGINE_DEADLINE_MS (45 000)
   * від старту збирача. Раннер, що знає свій старт, передає точне значення.
   */
  deadline?: number;
  /** За скільки до межі не починати нової роботи (сторінки, вибірки). Типово 10 000 мс. */
  deadlineMarginMs?: number;
  /** Годинник, мс. Типово Date.now. */
  now?: () => number;
}

/**
 * Результат збирача гаманців. `partial`: примітки за адресою, коли джерело відповіло
 * не повністю. Адреса, що не відповіла зовсім, у фактах відсутня (нуль замість неї
 * був би вигадкою) і має тут причину; адреса у фактах може мати тут пояснення null
 * (наприклад "swaps: not configured: HELIUS_KEY"). Сумісний із Fetched<T>.
 */
export type Collected<T> = Fetched<T> & { partial?: Record<string, string> };

/** Дописує примітку до адреси в partial. */
export function addNote(partial: Record<string, string>, address: string, note: string): void {
  partial[address] = partial[address] ? `${partial[address]}; ${note}` : note;
}

export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** Прибирає значення ключа з тексту, якщо чуже повідомлення його повторило. */
export function scrubKey(text: string, key: string | undefined): string {
  if (!key) return text;
  return text.split(key).join("***").split(encodeURIComponent(key)).join("***");
}

/** Скільки разів перечікувати ліміт, про який джерело каже в тілі відповіді (1 + 2 + 4 с). */
export const IN_BAND_RETRIES = 3;

/** Таймаут одного запиту і кількість повторів: три спроби по 25 с не влізли б у 45 с на людину. */
export const REQUEST_TIMEOUT_MS = 15_000;
export const REQUEST_RETRIES = 1;

export const DEFAULT_DEADLINE_MS = 45_000;
/** Нову роботу не починаємо пізніше, ніж за стільки до межі. */
export const DEADLINE_MARGIN_MS = 10_000;
/** Запити в польоті обриваємо за стільки до межі, щоб віддати виміряне раніше за раннер. */
export const HARD_STOP_MS = 2_000;
export const STOPPED_EARLY = "stopped early: deadline";

export interface Budget {
  /** Чи ще можна починати нову роботу. */
  open(): boolean;
  /** Сигнал для запитів: скасування викликачем або власна зупинка перед межею. */
  signal: AbortSignal;
  /** Чи спрацювала власна зупинка (а не скасування викликачем). */
  stopped(): boolean;
}

/**
 * Бюджет часу збирача. Після deadline − 10 с нових сторінок і вибірок не беремо,
 * а за 2 с до межі обриваємо запити в польоті: збирач віддає виміряне, а не падає
 * разом зі скасуванням усього збору людини.
 */
export function budgetFor(o: CollectOptions): Budget {
  const now = o.now ?? Date.now;
  const envMs = Number((o.env ?? process.env).ENGINE_DEADLINE_MS);
  const deadline = o.deadline ?? now() + (Number.isFinite(envMs) && envMs > 0 ? envMs : DEFAULT_DEADLINE_MS);
  const stopAt = deadline - (o.deadlineMarginMs ?? DEADLINE_MARGIN_MS);
  const hard = AbortSignal.timeout(Math.max(0, deadline - HARD_STOP_MS - now()));
  const signal = o.signal ? AbortSignal.any([o.signal, hard]) : hard;
  return {
    open: () => !signal.aborted && now() < stopAt,
    signal,
    stopped: () => hard.aborted && !o.signal?.aborted,
  };
}

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
