/**
 * Обмежувачі запитів до зовнішніх API.
 *
 * Кожен провайдер має свою стелю: Etherscan і публічний Solana RPC карають
 * за другий запит у ту саму мить, GitHub і Google терплять паралельні.
 * Обмежувач один на хост на весь процес, тож кілька людей у черзі
 * не множать навантаження на провайдера.
 */
export interface LimiterOptions {
  /** Скільки викликів може бути в польоті одночасно. */
  concurrency: number;
  /** Мінімальна пауза між двома сусідніми стартами, мс. */
  minIntervalMs: number;
}

export interface Limiter { run<T>(fn: () => Promise<T>): Promise<T> }

export function createLimiter({ concurrency, minIntervalMs }: LimiterOptions): Limiter {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError(`concurrency має бути цілим ≥ 1, а не ${concurrency}`);
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) throw new RangeError(`minIntervalMs має бути ≥ 0, а не ${minIntervalMs}`);

  const queue: Array<() => void> = [];
  let active = 0;
  let lastStart = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // performance.now() монотонний: перевід системного годинника назад не заморозить чергу.
  const pump = (): void => {
    while (queue.length > 0 && active < concurrency) {
      const wait = lastStart + minIntervalMs - performance.now();
      if (wait > 0) {
        timer ??= setTimeout(() => { timer = null; pump(); }, wait);
        return;
      }
      lastStart = performance.now();
      active++;
      queue.shift()!();
    }
  };

  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push(async () => {
          try {
            resolve(await fn());
          } catch (e) {
            reject(e);
          } finally {
            // Слот звільняється за будь-якого результату, інакше одна відмова заморозила б хост.
            active--;
            pump();
          }
        });
        pump();
      });
    },
  };
}

const HOST_DEFAULTS: Record<string, LimiterOptions> = {
  "ai.6551.io": { concurrency: 2, minIntervalMs: 500 },
  "api.etherscan.io": { concurrency: 1, minIntervalMs: 250 },
  "api.blockscout.com": { concurrency: 1, minIntervalMs: 250 },
  "api.hyperliquid.xyz": { concurrency: 4, minIntervalMs: 0 },
  "mainnet.helius-rpc.com": { concurrency: 4, minIntervalMs: 100 },
  "api.mainnet-beta.solana.com": { concurrency: 1, minIntervalMs: 300 },
  "api.github.com": { concurrency: 4, minIntervalMs: 0 },
  "www.googleapis.com": { concurrency: 4, minIntervalMs: 0 },
  "api.openchain.xyz": { concurrency: 2, minIntervalMs: 0 },
};
const OTHER_HOST: LimiterOptions = { concurrency: 4, minIntervalMs: 0 };

const shared = new Map<string, Limiter>();

/** Спільний обмежувач для хоста. Незнайомий хост отримує власний, з типовими межами. */
export function limiterFor(host: string): Limiter {
  const key = host.trim().toLowerCase();
  let limiter = shared.get(key);
  if (!limiter) {
    limiter = createLimiter(HOST_DEFAULTS[key] ?? OTHER_HOST);
    shared.set(key, limiter);
  }
  return limiter;
}
