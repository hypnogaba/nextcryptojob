import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Обмежувачі запитів до зовнішніх API. Єдиний дросель engine.
 *
 * Кожен провайдер має свій бюджет: Etherscan і публічний Solana RPC карають
 * за другий запит у ту саму мить, GitHub і Google терплять паралельні.
 * Бюджет один на весь процес, тож кілька людей у черзі не множать
 * навантаження на провайдера. safeFetch (http.ts) і D1Client (d1.ts)
 * беруть слот самі; збирачі run не викликають.
 *
 * Правило: run не можна викликати зсередини run того самого обмежувача.
 * Зовнішній виклик тримає слот і чекає внутрішнього, а внутрішній чекає
 * вільного слота; за concurrency 1 це вічне очікування. Тому такий виклик
 * одразу відмовляє з NestedRunError.
 */
export interface LimiterOptions {
  /** Скільки викликів може бути в польоті одночасно. */
  concurrency: number;
  /** Мінімальна пауза між двома сусідніми стартами, мс. */
  minIntervalMs: number;
}

export interface RunOptions {
  /** Скасування, поки виклик чекає в черзі. Після старту fn відповідає за себе сама. */
  signal?: AbortSignal;
}

export interface Limiter {
  run<T>(fn: () => Promise<T>, opts?: RunOptions): Promise<T>;
  /** Не стартувати нічого в цьому бюджеті раніше, ніж через ms (усі слоти). */
  backoff(ms: number): void;
  /** Скільки викликів чекає в черзі (без тих, що вже в польоті). */
  pending(): number;
}

export class NestedRunError extends Error {
  override name = "NestedRunError";
}

/** Слоти, які тримає поточний асинхронний ланцюжок. `done` гасить слот, щойно fn завершилась. */
type Held = { limiter: Limiter; done: boolean };
const held = new AsyncLocalStorage<readonly Held[]>();

interface Waiter { start: () => void; cancel?: () => void }

interface InternalLimiter extends Limiter { idle(): boolean }

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("Виклик скасовано до старту", "AbortError");

export function createLimiter({ concurrency, minIntervalMs }: LimiterOptions): Limiter {
  return makeLimiter({ concurrency, minIntervalMs });
}

function makeLimiter({ concurrency, minIntervalMs }: LimiterOptions): InternalLimiter {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError(`concurrency має бути цілим ≥ 1, а не ${concurrency}`);
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) throw new RangeError(`minIntervalMs має бути ≥ 0, а не ${minIntervalMs}`);

  const queue: Waiter[] = [];
  let active = 0;
  let lastStart = -Infinity;
  let notBefore = -Infinity;
  let timerArmed = false;

  // performance.now() монотонний: перевід системного годинника назад не заморозить чергу.
  const nextAllowed = (): number => Math.max(lastStart + minIntervalMs, notBefore);

  const pump = (): void => {
    while (queue.length > 0 && active < concurrency) {
      const wait = nextAllowed() - performance.now();
      if (wait > 0) {
        if (!timerArmed) {
          timerArmed = true;
          setTimeout(() => { timerArmed = false; pump(); }, wait);
        }
        return;
      }
      lastStart = performance.now();
      active++;
      queue.shift()!.start();
    }
  };

  const self: InternalLimiter = {
    run<T>(fn: () => Promise<T>, opts: RunOptions = {}): Promise<T> {
      const outer = held.getStore() ?? [];
      if (outer.some((h) => h.limiter === self && !h.done)) {
        return Promise.reject(new NestedRunError(
          "run викликано зсередини run того самого обмежувача: зовнішній виклик тримає слот, " +
          "внутрішній чекав би його вічно. Візьміть слот один раз на весь запит."));
      }
      const { signal } = opts;
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      // Виклик стартує з контексту того, хто його поставив, а не того, хто звільнив слот.
      const inCallerContext = AsyncLocalStorage.snapshot();

      return new Promise<T>((resolve, reject) => {
        const waiter: Waiter = {
          start: () => {
            signal?.removeEventListener("abort", onAbort);
            const token: Held = { limiter: self, done: false };
            inCallerContext(() => held.run([...outer, token], async () => {
              try {
                // Через мікрозадачу: синхронний throw у fn не рекурсує через pump.
                resolve(await Promise.resolve().then(fn));
              } catch (e) {
                reject(e);
              } finally {
                // Слот звільняється за будь-якого результату, інакше одна відмова заморозила б бюджет.
                token.done = true;
                active--;
                pump();
              }
            }));
          },
        };
        const onAbort = (): void => {
          const i = queue.indexOf(waiter);
          if (i >= 0) { queue.splice(i, 1); reject(abortReason(signal!)); }
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        queue.push(waiter);
        pump();
      });
    },

    backoff(ms: number): void {
      if (!(ms > 0)) return;
      notBefore = Math.max(notBefore, performance.now() + ms);
      // Взведений таймер спрацює раніше і перезведеться з новою межею в pump.
    },

    pending: () => queue.length,

    idle: () => active === 0 && queue.length === 0 && nextAllowed() <= performance.now(),
  };
  return self;
}

/** Хости одного провайдера з одним спільним лімітом. */
const ALIASES: Record<string, string> = {
  "api.blockscout.com": "blockscout",
  "api.etherscan.io": "etherscan",
  "ai.6551.io": "6551",
  "api.helius.xyz": "helius",
  "api.cloudflare.com": "cloudflare",
  // Сканер вакансій (src/jobs): хости однієї дошки під різними іменами.
  "remote3.co": "remote3",
  "www.remote3.co": "remote3",
  "web3.career": "web3career",
  "www.web3.career": "web3career",
};
const SUFFIX_ALIASES: Array<[suffix: string, budget: string]> = [
  [".blockscout.com", "blockscout"],
  [".helius-rpc.com", "helius"],
  // ATS, де компанія живе на своєму піддомені: бюджет один на провайдера, а не на компанію.
  [".recruitee.com", "recruitee"],
  [".breezy.hr", "breezy"],
  [".bamboohr.com", "bamboohr"],
  [".jobs.personio.de", "personio"],
  [".teamtailor.com", "teamtailor"],
];

/** Бюджет пошуку GitHub (api.github.com/search/...). */
export const GITHUB_SEARCH = "github-search";

/** Бюджети за хостом і початком шляху: той самий хост, але інший ліміт провайдера. */
const PATH_BUDGETS: Array<[hostBudget: string, pathPrefix: string, budget: string]> = [
  ["api.github.com", "/search/", GITHUB_SEARCH],
];

const BUDGET_DEFAULTS: Record<string, LimiterOptions> = {
  "6551": { concurrency: 2, minIntervalMs: 800 }, // ≤ 1,25 зап./с: під навантаженням 6551 віддає порожні дані (ворота якості 12.09); 2, щоб завислий запит не блокував решту
  etherscan: { concurrency: 1, minIntervalMs: 250 },
  blockscout: { concurrency: 1, minIntervalMs: 250 },
  helius: { concurrency: 4, minIntervalMs: 100 },
  cloudflare: { concurrency: 4, minIntervalMs: 250 },
  "api.hyperliquid.xyz": { concurrency: 4, minIntervalMs: 0 },
  "api.mainnet-beta.solana.com": { concurrency: 1, minIntervalMs: 300 },
  "api.github.com": { concurrency: 4, minIntervalMs: 0 },
  // Пошук GitHub має власний ліміт: 30 запитів на хвилину з токеном. Окремий бюджет, щоб
  // він не гальмував GraphQL і core (ключ з хоста й шляху, budgetKeyForUrl).
  [GITHUB_SEARCH]: { concurrency: 1, minIntervalMs: 2_000 },
  // Sherlock (audits): JSON їхнього сайту, без ключа; не частіше, ніж дослідження (2,5 с).
  "mainnet-contest.sherlock.xyz": { concurrency: 1, minIntervalMs: 2_500 },
  // Власний Blockscout мережі Optimism (не *.blockscout.com): публічний, по одному.
  "explorer.optimism.io": { concurrency: 1, minIntervalMs: 250 },
  "www.googleapis.com": { concurrency: 4, minIntervalMs: 0 },
  "api.openchain.xyz": { concurrency: 2, minIntervalMs: 0 },
  // Добірка (digest/deliver.ts): Bot API дозволяє близько 30 повідомлень на секунду на бота; ми йдемо ≤ 25.
  "api.telegram.org": { concurrency: 1, minIntervalMs: 40 },
  // Сканер вакансій (src/jobs, jobs-scan раз на добу). Публічні API дошок вакансій терплять
  // паралельні запити, але кожен провайдер бачить нас однією адресою: не більше кількох водночас.
  "boards-api.greenhouse.io": { concurrency: 4, minIntervalMs: 100 },
  "api.ashbyhq.com": { concurrency: 4, minIntervalMs: 100 },
  "api.lever.co": { concurrency: 3, minIntervalMs: 150 },
  "api.eu.lever.co": { concurrency: 2, minIntervalMs: 150 },
  "apply.workable.com": { concurrency: 2, minIntervalMs: 300 },
  "api.smartrecruiters.com": { concurrency: 2, minIntervalMs: 300 },
  "api.rippling.com": { concurrency: 2, minIntervalMs: 300 },
  recruitee: { concurrency: 2, minIntervalMs: 300 },
  breezy: { concurrency: 2, minIntervalMs: 300 },
  bamboohr: { concurrency: 2, minIntervalMs: 300 },
  personio: { concurrency: 2, minIntervalMs: 300 },
  teamtailor: { concurrency: 1, minIntervalMs: 500 },
  // Офіційний Web3 Jobs API (src/jobs/sources/web3career.ts): ліміт не названо, лише 429 при надмірі.
  // 51 запит раз на добу, по одному, з паузою 1,5 с: близько 80 с на скан.
  web3career: { concurrency: 1, minIntervalMs: 1_500 },
  // Дошки гортаються сторінками: по одній і з паузою, як людина, що гортає список.
  "jobstash.xyz": { concurrency: 1, minIntervalMs: 500 },
  remote3: { concurrency: 1, minIntervalMs: 1_000 },
  "speedrun-talent-network.com": { concurrency: 2, minIntervalMs: 250 },
  "superteam.fun": { concurrency: 1, minIntervalMs: 1_000 },
  // Getro лише в розвідці (раз на тиждень, JOBS_GETRO_DISCOVERY=1): по одному запиту раз на 1,5 с, тротлить агресивно.
  "api.getro.com": { concurrency: 1, minIntervalMs: 1_500 },
};
const OTHER_HOST: LimiterOptions = { concurrency: 4, minIntervalMs: 0 };

/** Стеля для backoff: довше хвилини чекати не варто, краще віддати прогалину. */
export const MAX_BACKOFF_MS = 60_000;

/**
 * Ключ бюджету для хоста: нижній регістр, без крапки в кінці й без порту,
 * а хости одного провайдера зводяться до одного імені. Ідемпотентний:
 * budgetKey(budgetKey(x)) === budgetKey(x).
 */
export function budgetKey(hostOrBudget: string): string {
  let h = hostOrBudget.trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(h);
  if (bracketed) h = bracketed[1]!;
  else if (/^[^:]+:\d+$/.test(h)) h = h.slice(0, h.lastIndexOf(":"));
  h = h.replace(/\.+$/, "");
  const alias = ALIASES[h];
  if (alias) return alias;
  for (const [suffix, budget] of SUFFIX_ALIASES) if (h.endsWith(suffix)) return budget;
  return h;
}

/**
 * Ключ бюджету для адреси: як budgetKey(хост), але шлях може вибрати окремий бюджет
 * (пошук GitHub: свій ліміт 30/хв, окремо від GraphQL). safeFetch і backoffFor беруть його.
 */
export function budgetKeyForUrl(url: string | URL): string {
  const u = typeof url === "string" ? new URL(url) : url;
  const host = budgetKey(u.hostname);
  for (const [h, prefix, budget] of PATH_BUDGETS) if (host === h && u.pathname.startsWith(prefix)) return budget;
  return host;
}

const registry = new Map<string, InternalLimiter>();

/**
 * Спільний обмежувач для хоста або ключа бюджету.
 *
 * Незнайомий хост отримує власний обмежувач із типовими межами, а коли той
 * простоює, його прибирають, щоб реєстр не ріс із кожним сайтом кандидата.
 * Тому посилання на обмежувач незнайомого хоста не зберігайте: беріть
 * limiterFor(host) щоразу перед run.
 */
export function limiterFor(hostOrBudget: string): Limiter {
  const key = budgetKey(hostOrBudget);
  let limiter = registry.get(key);
  if (!limiter) {
    for (const [k, l] of registry) if (!(k in BUDGET_DEFAULTS) && l.idle()) registry.delete(k);
    limiter = makeLimiter(BUDGET_DEFAULTS[key] ?? OTHER_HOST);
    registry.set(key, limiter);
  }
  return limiter;
}

/**
 * Відсунути всі старти бюджету, до якого належить адреса (з урахуванням шляху) чи хост.
 * Для лімітів, про які провайдер каже в тілі відповіді, а не статусом 429
 * (Etherscan відповідає 200 з "Max rate limit reached").
 */
export function backoffFor(urlOrHost: string | URL, ms: number): void {
  const key = urlOrHost instanceof URL || urlOrHost.includes("://") ? budgetKeyForUrl(urlOrHost) : urlOrHost;
  limiterFor(key).backoff(Math.min(ms, MAX_BACKOFF_MS));
}

/** Лише для тестів: забути всі обмежувачі. */
export function __resetLimiters(): void {
  registry.clear();
}

/** Лише для тестів: інші межі бюджету до наступного __resetLimiters (напр. без паузи між запитами). */
export function __setLimiter(hostOrBudget: string, options: LimiterOptions): void {
  registry.set(budgetKey(hostOrBudget), makeLimiter(options));
}
