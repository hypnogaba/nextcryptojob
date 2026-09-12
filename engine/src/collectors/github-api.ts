import { readCapped, redact, safeFetch, UnsafeUrlError } from "../http.js";
import { backoffFor } from "../limits.js";
import {
  describeError, fetchOpts, GapError, notConfigured, nowMs, pause, type CollectorContext,
} from "./context.js";

/**
 * Запити до api.github.com для збирачів github і dune.
 *
 * Ліміт GitHub приходить як 403/429 з x-ratelimit-remaining: 0 (або GraphQL 200 з
 * помилкою RATE_LIMITED) і часом скидання в x-ratelimit-reset. Якщо скидання
 * ближче за GITHUB_MAX_WAIT_MS, чекаємо його і пробуємо ще раз; далі або вдруге
 * поспіль ліміт → прогалина одразу, без сну. Ліміт core/graphql відсуває бюджет
 * api.github.com, ліміт пошуку (свій, 30 на хвилину) чекає лише цей виклик.
 * Бюджет для всіх не стоїть довше GITHUB_MAX_WAIT_MS: дедлайн людини 45 с.
 */
export const GITHUB_API = "https://api.github.com";
export const GITHUB_MAX_WAIT_MS = 15_000;
/** 429 без жодного заголовка про час. */
const DEFAULT_LIMIT_WAIT_MS = 5_000;
const MAX_GITHUB_BODY = 4 * 1024 * 1024;
const SERVER_RETRIES = 2;

/** Логін GitHub: латиниця, цифри, дефіс, до 39 символів (без пробілів: інакше це інший запит пошуку). */
export const GITHUB_LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
export const normalizeLogin = (login: string): string => login.trim().replace(/^@/, "").toLowerCase();

/** Скільки мс до скидання ліміту, або null, якщо відповідь не про ліміт. */
export function rateLimitWaitMs(status: number, headers: Headers, now: number, graphqlLimited = false): number | null {
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = Number(headers.get("x-ratelimit-reset"));
  const retryAfter = Number(headers.get("retry-after"));
  const limited = graphqlLimited || ((status === 403 || status === 429) &&
    (remaining === "0" || headers.has("retry-after") || status === 429));
  if (!limited) return null;
  if (headers.has("retry-after") && Number.isFinite(retryAfter)) return Math.max(0, retryAfter * 1000);
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - now) + 1_000;
  return DEFAULT_LIMIT_WAIT_MS;
}

type GraphqlError = { type?: string; message?: string };

export async function githubJson<T>(url: string, init: RequestInit, ctx: CollectorContext): Promise<T> {
  const token = ctx.env.GITHUB_TOKEN;
  if (!token) throw notConfigured("GITHUB_TOKEN");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (!headers.has("Accept")) headers.set("Accept", "application/vnd.github+json");
  headers.set("User-Agent", "NextCryptoJobBot/0.1 (+https://nextcryptojob.xyz)");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  const shown = redact(url);
  let limitedOnce = false;
  let failures = 0;

  for (;;) {
    let res: Response;
    try {
      res = await safeFetch(url, { ...init, headers, signal: ctx.signal }, fetchOpts(ctx, { backoffOn429Ms: DEFAULT_LIMIT_WAIT_MS, maxBackoffMs: GITHUB_MAX_WAIT_MS }));
    } catch (e) {
      if (ctx.signal?.aborted || e instanceof UnsafeUrlError) throw e;
      if (++failures > SERVER_RETRIES) throw new GapError(`GitHub unreachable (${describeError(e)})`);
      await pause(ctx, 1_000 * failures);
      continue;
    }

    let body: unknown = null;
    if (res.ok) {
      const text = await readCapped(res, MAX_GITHUB_BODY, shown);
      try { body = JSON.parse(text); } catch { throw new GapError("GitHub returned non-JSON"); }
    } else {
      await res.body?.cancel().catch(() => undefined);
    }
    const errors = (body as { errors?: GraphqlError[] } | null)?.errors;
    const graphqlLimited = Array.isArray(errors) && errors.some((e) => e?.type === "RATE_LIMITED");

    const wait = rateLimitWaitMs(res.status, res.headers, nowMs(ctx), graphqlLimited);
    if (wait !== null) {
      if (limitedOnce || wait > GITHUB_MAX_WAIT_MS) {
        throw new GapError(`GitHub rate limit (resets in ${Math.ceil(wait / 1000)} s)`);
      }
      limitedOnce = true;
      if (res.headers.get("x-ratelimit-resource") === "search") await pause(ctx, wait);
      else backoffFor(url, wait);   // наступний старт у бюджеті api.github.com чекатиме скидання
      continue;
    }
    if (res.status === 401) throw new GapError("GitHub rejected the token (HTTP 401)");
    if (res.status >= 500) {
      if (++failures > SERVER_RETRIES) throw new GapError(`GitHub HTTP ${res.status}`);
      await pause(ctx, 1_000 * failures);
      continue;
    }
    if (!res.ok) throw new GapError(`GitHub HTTP ${res.status}`);
    return body as T;
  }
}
