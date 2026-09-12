import type { DuneFacts, Fetched } from "../types.js";
import { collect, DAY_MS, GapError, notConfigured, nowMs, pause, type CollectorContext } from "./context.js";
import { GITHUB_API, GITHUB_LOGIN, githubJson, normalizeLogin } from "./github-api.js";

/**
 * Злиті PR людини в duneanalytics/spellbook через пошук GitHub (research/harness/collect_dune.py).
 * Профілі dune.com не збираємо: офіційного API немає, сайт за перевіркою Cloudflare.
 */
export const SPELLBOOK = "duneanalytics/spellbook";
/** Пошук GitHub: 30 запитів на хвилину з токеном. Між двома запитами людини пауза. */
export const SEARCH_PAUSE_MS = 2_500;

/** Дата початку вікна 12 місяців для `merged:>=`, UTC. */
export const since12m = (now: number): string => new Date(now - 365 * DAY_MS).toISOString().slice(0, 10);

export const spellbookQuery = (login: string, since?: string): string =>
  `is:pr is:merged author:${login} repo:${SPELLBOOK}` + (since ? ` merged:>=${since}` : "");

async function searchCount(q: string, ctx: CollectorContext): Promise<number> {
  const url = `${GITHUB_API}/search/issues?q=${encodeURIComponent(q)}&per_page=1`;
  const res = await githubJson<{ total_count?: unknown }>(url, { method: "GET" }, ctx);
  const n = res?.total_count;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new GapError("GitHub search returned no total_count");
  return n;
}

export async function collectDune(githubLogin: string, ctx: CollectorContext): Promise<Fetched<DuneFacts>> {
  return collect("dune", ctx, async () => {
    if (!ctx.env.GITHUB_TOKEN) throw notConfigured("GITHUB_TOKEN");
    const login = normalizeLogin(githubLogin);
    // Логін іде в рядок пошуку: пробіл або двокрапка змінили б сам запит.
    if (!GITHUB_LOGIN.test(login)) throw new GapError("invalid GitHub login");
    const total = await searchCount(spellbookQuery(login), ctx);
    if (total === 0) return { spellbookPrs: 0, spellbookPrs12m: 0 };
    await pause(ctx, SEARCH_PAUSE_MS);
    const recent = await searchCount(spellbookQuery(login, since12m(nowMs(ctx))), ctx);
    return { spellbookPrs: total, spellbookPrs12m: recent };
  });
}
