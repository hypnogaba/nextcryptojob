// Лише для тестів збирачів (виключено з tsc build у tsconfig.json).
import type { CollectorContext } from "./context.js";

export type Call = { url: URL; init: RequestInit; body: unknown };
export type Handler = (url: URL, init: RequestInit, body: unknown) => Response | Promise<Response>;

/** fetch під safeFetch: записує виклики і відповідає обробником. Обмежувач і маскування ключів працюють як у бою. */
export function mockFetch(handler: Handler): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (u: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(u));
    const i = init ?? {};
    let body: unknown = i.body ?? null;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { /* текст як є */ } }
    calls.push({ url, init: i, body });
    const res = await handler(url, i, body);
    // Як у справжнього fetch із redirect: "manual": url відповіді = адреса цього стрибка.
    if (!res.url) Object.defineProperty(res, "url", { value: url.toString() });
    return res;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export const text = (body: string, status = 200, contentType = "application/xml"): Response =>
  new Response(body, { status, headers: { "content-type": contentType } });

/** Фіксований годинник: 2026-09-12 12:00:00 UTC. */
export const NOW = Date.UTC(2026, 8, 12, 12, 0, 0);

export function ctxWith(fetchImpl: typeof fetch, env: Record<string, string> = {}, extra: Partial<CollectorContext> = {}): CollectorContext & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    env, fetchImpl, now: () => NOW,
    sleep: async (ms) => { sleeps.push(ms); },
    sleeps,
    ...extra,
  };
}
