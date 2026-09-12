import { beforeEach, describe, expect, it } from "vitest";
import { __resetLimiters } from "../limits.js";
import { collectDune, SEARCH_PAUSE_MS, since12m } from "./dune.js";
import { ctxWith, json, mockFetch, NOW } from "./testkit.js";

const env = { GITHUB_TOKEN: "ghp_secretTestToken000" };
// Синтетична відповідь search/issues у формі справжньої (per_page=1).
const search = (total: number) => json({ total_count: total, incomplete_results: false,
  items: total ? [{ number: 1, state: "closed", pull_request: { merged_at: "2026-08-01T00:00:00Z" } }] : [] });
const q = (u: URL) => u.searchParams.get("q") ?? "";

beforeEach(() => { __resetLimiters(); });

describe("collectDune", () => {
  it("вікно 12 місяців: дата за 365 днів до зараз, UTC", () => {
    expect(since12m(NOW)).toBe("2025-09-12");
    expect(since12m(Date.UTC(2026, 0, 1, 0, 30))).toBe("2025-01-01");
  });

  it("усього й за 12 місяців двома запитами пошуку з паузою між ними", async () => {
    const { fetchImpl, calls } = mockFetch((u) => (q(u).includes("merged:>=") ? search(5) : search(12)));
    const ctx = ctxWith(fetchImpl, env);
    expect(await collectDune("Test-Dev", ctx)).toEqual({ ok: true, facts: { spellbookPrs: 12, spellbookPrs12m: 5 } });
    expect(calls.map((c) => q(c.url))).toEqual([
      "is:pr is:merged author:test-dev repo:duneanalytics/spellbook",
      "is:pr is:merged author:test-dev repo:duneanalytics/spellbook merged:>=2025-09-12",
    ]);
    expect(calls[0]!.url.pathname).toBe("/search/issues");
    expect(calls[0]!.url.searchParams.get("per_page")).toBe("1");
    expect(ctx.sleeps).toEqual([SEARCH_PAUSE_MS]);
  });

  it("нуль PR: другого запиту немає, факти 0 (формула сама дасть null)", async () => {
    const { fetchImpl, calls } = mockFetch(() => search(0));
    expect(await collectDune("test-dev", ctxWith(fetchImpl, env))).toEqual({ ok: true, facts: { spellbookPrs: 0, spellbookPrs12m: 0 } });
    expect(calls).toHaveLength(1);
  });

  it("без GITHUB_TOKEN: not configured", async () => {
    const { fetchImpl, calls } = mockFetch(() => search(1));
    expect(await collectDune("test-dev", ctxWith(fetchImpl, {}))).toEqual({ ok: false, gap: "not configured: GITHUB_TOKEN" });
    expect(calls).toHaveLength(0);
  });

  it("логін, що змінив би запит пошуку, відкидається без запиту", async () => {
    const { fetchImpl, calls } = mockFetch(() => search(1));
    for (const bad of ["evil repo:other/repo", "a:b", ""]) {
      expect(await collectDune(bad, ctxWith(fetchImpl, env))).toEqual({ ok: false, gap: "dune: invalid GitHub login" });
    }
    expect(calls).toHaveLength(0);
  });

  it("ліміт пошуку чекає лише цей виклик (ctx.sleep), бюджет GitHub не зупиняє", async () => {
    let n = 0;
    const { fetchImpl } = mockFetch(() => (++n === 1
      ? json({ message: "API rate limit exceeded" }, 403, {
        "x-ratelimit-remaining": "0", "x-ratelimit-resource": "search",
        "x-ratelimit-reset": String(Math.floor(NOW / 1000) + 10) })
      : search(0)));
    const ctx = ctxWith(fetchImpl, env);
    expect(await collectDune("test-dev", ctx)).toEqual({ ok: true, facts: { spellbookPrs: 0, spellbookPrs12m: 0 } });
    expect(ctx.sleeps).toEqual([11_000]);
  });

  it("ліміт пошуку зі скиданням далі за 15 с: прогалина без сну", async () => {
    const { fetchImpl, calls } = mockFetch(() => json({ message: "API rate limit exceeded" }, 403, {
      "x-ratelimit-remaining": "0", "x-ratelimit-resource": "search",
      "x-ratelimit-reset": String(Math.floor(NOW / 1000) + 40) }));
    const ctx = ctxWith(fetchImpl, env);
    expect(await collectDune("test-dev", ctx)).toMatchObject({ ok: false, gap: expect.stringMatching(/^dune: GitHub rate limit/) });
    expect(ctx.sleeps).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("422 від пошуку: прогалина з кодом", async () => {
    const { fetchImpl } = mockFetch(() => json({ message: "Validation Failed" }, 422));
    expect(await collectDune("test-dev", ctxWith(fetchImpl, env))).toEqual({ ok: false, gap: "dune: GitHub HTTP 422" });
  });
});
