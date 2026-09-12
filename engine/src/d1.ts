// Перенесено з NextRole (написано до запуску 14.09.2026).
import { limiterFor, MAX_BACKOFF_MS } from "./limits.js";

export interface D1Credentials { accountId: string; databaseId: string; token: string }
export interface D1Statement { sql: string; params?: unknown[] }

export interface StatementOptions {
  /**
   * Чи можна безпечно повторити інструкцію, якщо відповідь загубилась
   * (таймаут, обрив, 5xx). Без вказівки повторюються лише чисті читання.
   * Ставте true для INSERT OR IGNORE по унікальному ключу, UPSERT без
   * приростів тощо. `UPDATE ... attempts=attempts+1` не ідемпотентний:
   * повтор після загубленої відповіді рахує спробу двічі.
   */
  idempotent?: boolean;
}

/** Що D1 каже про виконання інструкції (частина полів meta відповіді REST). */
export interface D1Meta { rowsRead: number | null; rowsWritten: number | null; durationMs: number | null }

interface D1Envelope<T> {
  success: boolean;
  result: Array<{ success: boolean; results?: T[];
    meta?: { changes?: unknown; rows_read?: unknown; rows_written?: unknown; duration?: unknown } }>;
  errors: Array<{ code: number; message: string }>;
}

/** D1 не любить величезні пакети; 50 інструкцій за виклик безпечно. */
const MAX_PER_CALL = 50;

/**
 * D1 через REST API. Engine живе на звичайному сервері, а не в Worker,
 * тому прив'язки D1 немає, усе йде по HTTPS. Кожна спроба бере слот
 * бюджету cloudflare (limits.ts), спільного для всього процесу.
 */
export interface D1Options {
  fetchImpl?: typeof fetch;
  /** Скільки разів пробувати. Що саме повторюється, див. post(). */
  attempts?: number;
  /** Пауза перед другою спробою; далі подвоюється. */
  retryDelayMs?: number;
  /** Скільки чекати одну відповідь; відлік від отримання слота. */
  timeoutMs?: number;
}

/**
 * 5xx від D1: сервер, не ми. 429 окремо (D1ThrottledError).
 *
 * 429 до 03.09 падав у гілку «винні ми» разом з рештою 4xx. Того дня
 * Cloudflare дві з половиною хвилини віддавав 429 з кодом 7429 при майже
 * порожній базі NextRole, і частина профілів вилетіла з прогону.
 */
const TRANSIENT = new Set([500, 502, 503, 504, 520, 521, 522, 523, 524]);

/**
 * 429 чекає довше за 5xx: 5xx це збій одного виклику, 429 це стан акаунта
 * на десятки секунд. Множник дає 3 спроби на 5 с і 15 с.
 */
const THROTTLE_DELAY_MULTIPLIER = 5;

const D1_HOST = "api.cloudflare.com";

/**
 * Чисте читання: SELECT, EXPLAIN або WITH без запису, і лише одна інструкція.
 * PRAGMA сюди не входить, бо вміє писати.
 */
function isReadOnly(sql: string): boolean {
  const s = sql.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, "");
  if (/;\s*\S/.test(s)) return false;
  if (/^(select|explain)\b/i.test(s)) return true;
  return /^with\b/i.test(s) && !/\b(insert|update|delete|replace)\b/i.test(s);
}

export class D1Client {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly attempts: number;
  private readonly retryDelayMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly creds: D1Credentials, opts: D1Options | typeof fetch = {}) {
    // Другим аргументом досі приймали fetch напряму; лишаємо це для старих викликів.
    const o: D1Options = typeof opts === "function" ? { fetchImpl: opts } : opts;
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.attempts = o.attempts ?? 3;
    this.retryDelayMs = o.retryDelayMs ?? 1_000;
    this.timeoutMs = o.timeoutMs ?? 30_000;
    this.endpoint =
      `https://${D1_HOST}/client/v4/accounts/${creds.accountId}/d1/database/${creds.databaseId}/query`;
  }

  /** Рядки результату. Для `UPDATE ... RETURNING` передайте idempotent, якщо повтор безпечний. */
  async query<T>(sql: string, params: unknown[] = [], opts: StatementOptions = {}): Promise<T[]> {
    const env = await this.post<T>({ sql, params }, opts.idempotent ?? isReadOnly(sql));
    return env.result[0]?.results ?? [];
  }

  /** Як query, але ще й з meta D1 (скільки рядків прочитано, скільки тривало на сервері). */
  async queryWithMeta<T>(sql: string, params: unknown[] = [], opts: StatementOptions = {}): Promise<{ results: T[]; meta: D1Meta }> {
    const env = await this.post<T>({ sql, params }, opts.idempotent ?? isReadOnly(sql));
    const first = env.result[0];
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return {
      results: first?.results ?? [],
      meta: { rowsRead: num(first?.meta?.rows_read), rowsWritten: num(first?.meta?.rows_written), durationMs: num(first?.meta?.duration) },
    };
  }

  async execute(sql: string, params: unknown[] = [], opts: StatementOptions = {}): Promise<void> {
    await this.post({ sql, params }, opts.idempotent ?? isReadOnly(sql));
  }

  /** Інструкція, що змінює дані; повертає кількість змінених рядків (meta.changes). */
  async run(sql: string, params: unknown[] = [], opts: StatementOptions = {}): Promise<{ changes: number }> {
    const env = await this.post({ sql, params }, opts.idempotent ?? isReadOnly(sql));
    const changes = env.result[0]?.meta?.changes;
    if (typeof changes !== "number") {
      // Нуль тут означав би «рядок не взято», а насправді ми просто не знаємо.
      throw new D1HttpError("D1 відповів без meta.changes; результат інструкції невідомий");
    }
    return { changes };
  }

  async batch(statements: D1Statement[], opts: StatementOptions = {}): Promise<void> {
    for (let i = 0; i < statements.length; i += MAX_PER_CALL) {
      const chunk = statements.slice(i, i + MAX_PER_CALL);
      const idempotent = opts.idempotent ?? chunk.every((s) => isReadOnly(s.sql));
      await this.post({ batch: chunk.map((s) => ({ sql: s.sql, params: s.params ?? [] })) }, idempotent);
    }
  }

  /**
   * Один POST із повторами.
   *
   * 429 повторюється завжди: сервер відмовив до виконання. Мережевий збій,
   * таймаут і 5xx повторюються лише для ідемпотентних інструкцій: відповідь
   * могла загубитись уже після того, як запис відбувся. 4xx і помилка SQL
   * повертаються одразу, там винні ми.
   */
  private async post<T>(body: unknown, idempotent: boolean): Promise<D1Envelope<T>> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      const throttleFallbackMs = this.retryDelayMs * 2 ** (attempt - 1) * THROTTLE_DELAY_MULTIPLIER;
      try {
        return await this.postOnce<T>(body, throttleFallbackMs);
      } catch (e) {
        lastError = e;
        const throttled = e instanceof D1ThrottledError;
        const lostAnswer = e instanceof D1TransientError || !(e instanceof D1HttpError);
        const retryable = throttled || (idempotent && lostAnswer);
        if (!retryable || attempt === this.attempts) {
          if (lostAnswer && !throttled && !idempotent && attempt < this.attempts) {
            console.log(`  D1: ${describe(e)}; не повторюю, бо інструкція змінює дані і могла вже виконатись`);
          }
          throw e;
        }
        // Retry-After від сервера головніший за нашу здогадку, якщо він є.
        const wait = throttled
          ? e.retryAfterMs ?? throttleFallbackMs
          : this.retryDelayMs * 2 ** (attempt - 1);
        console.log(`  D1: спроба ${attempt}/${this.attempts} не вдалась (${describe(e)}), повтор через ${wait} мс`);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    }
    throw lastError;
  }

  private postOnce<T>(body: unknown, throttleFallbackMs: number): Promise<D1Envelope<T>> {
    const limiter = limiterFor(D1_HOST);
    return limiter.run(async () => {
      const res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.creds.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        const text = await res.text();
        if (res.status === 401 || res.status === 403) {
          // Самооновити тимчасовий токен не можна: refresh-токен Cloudflare одноразовий
          // і ротується, тож сервер і локальний wrangler билися б за один і той самий.
          throw new D1HttpError(
            `D1 відмовив у доступі (HTTP ${res.status}). Перевірте /etc/nextcryptojob-engine.env: ` +
            "CF_API_TOKEN має бути постійним API-токеном, а не тимчасовим OAuth-токеном wrangler " +
            "(той діє близько години); токен має мати право D1:Edit саме на базу nextcryptojob; " +
            "CF_ACCOUNT_ID і CF_D1_DATABASE_ID мають вказувати на цю базу. " +
            "Токен створюють у dash.cloudflare.com, My Profile, API Tokens, Create Custom Token. " +
            `Відповідь: ${text.slice(0, 200)}`);
        }
        if (res.status === 429) {
          // Заголовок необов'язковий: Cloudflare 03.09 не прислав жодного.
          const after = Number(res.headers.get("retry-after"));
          const retryAfterMs = Number.isFinite(after) && after > 0 ? Math.min(after * 1_000, MAX_BACKOFF_MS) : null;
          // Ще до звільнення слота: жоден інший запит акаунта не проскочить у паузу.
          limiter.backoff(retryAfterMs ?? throttleFallbackMs);
          throw new D1ThrottledError(`D1 HTTP ${res.status}: ${text.slice(0, 300)}`, retryAfterMs);
        }
        if (TRANSIENT.has(res.status)) throw new D1TransientError(`D1 HTTP ${res.status}: ${text.slice(0, 300)}`);
        throw new D1HttpError(`D1 HTTP ${res.status}: ${text}`);
      }
      const env = (await res.json()) as D1Envelope<T>;
      if (!env.success) {
        // Помилка в самому SQL: повтор не допоможе.
        throw new D1HttpError(`D1 помилка: ${env.errors.map((e) => e.message).join("; ") || "невідома"}`);
      }
      return env;
    });
  }
}

/** Відповідь прийшла, і вона остаточна: наш SQL, наш токен, наш запит. */
export class D1HttpError extends Error { override name = "D1HttpError"; }
/** Відповідь 5xx: сервер, не ми. Для ідемпотентних інструкцій варто спробувати ще. */
export class D1TransientError extends D1HttpError { override name = "D1TransientError"; }
/** 429: сервер просить почекати. Повторюємо завжди, але помітно довше. */
export class D1ThrottledError extends D1TransientError {
  override name = "D1ThrottledError";
  constructor(message: string, readonly retryAfterMs: number | null = null) { super(message); }
}

const describe = (e: unknown): string => {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as { cause?: unknown }).cause;
  return cause instanceof Error ? `${e.message}: ${cause.message}` : e.message;
};
