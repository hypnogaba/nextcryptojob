import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetLimiters } from "../limits.js";
import { collectGithub, TEAM_MIN_COMMITS, teamQuery, teamWork } from "./github.js";
import { GITHUB_MAX_WAIT_MS, rateLimitWaitMs } from "./github-api.js";
import { ctxWith, json, mockFetch, NOW } from "./testkit.js";

const TOKEN = "ghp_secretTestToken000";
const env = { GITHUB_TOKEN: TOKEN };

// Синтетична відповідь GraphQL у формі справжньої.
const USER = {
  data: { user: {
    createdAt: "2019-04-01T10:00:00Z",
    followers: { totalCount: 250 },
    repositories: { nodes: [
      { stargazerCount: 120, pushedAt: "2026-08-30T10:00:00Z", homepageUrl: "https://tool.example.org" },
      { stargazerCount: 30, pushedAt: "2025-01-01T00:00:00Z", homepageUrl: "" },
      { stargazerCount: 0, pushedAt: "2026-02-01T00:00:00Z", homepageUrl: null },
    ] },
    pullRequests: { totalCount: 40, nodes: [
      { repository: { owner: { login: "other-org" } } },
      { repository: { owner: { login: "Test-Dev" } } },
      { repository: { owner: { login: "another-org" } } },
      { repository: { owner: { login: "test-dev" } } },
    ] },
    contributionsCollection: { totalCommitContributions: 812, totalPullRequestReviewContributions: 37 },
  } },
};
// Відповідь запиту командної роботи (аліаси за роками).
const TEAM = { data: { user: {
  y2025: { commitContributionsByRepository: [
    { contributions: { totalCount: 15 }, repository: { nameWithOwner: "acme/protocol", stargazerCount: 9000, isFork: false, owner: { login: "acme" } } },
    { contributions: { totalCount: 50 }, repository: { nameWithOwner: "test-dev/own", stargazerCount: 700, isFork: false, owner: { login: "Test-Dev" } } },
  ] },
  y2026: { commitContributionsByRepository: [
    { contributions: { totalCount: 10 }, repository: { nameWithOwner: "acme/protocol", stargazerCount: 9000, isFork: false, owner: { login: "acme" } } },
    { contributions: { totalCount: 99 }, repository: { nameWithOwner: "x/fork", stargazerCount: 50, isFork: true, owner: { login: "x" } } },
    { contributions: { totalCount: 3 }, repository: { nameWithOwner: "big/lib", stargazerCount: 40000, isFork: false, owner: { login: "big" } } },
  ] },
} } };
const isTeam = (body: unknown) => String((body as { query?: string } | null)?.query ?? "").includes("commitContributionsByRepository");
const NOT_FOUND = { data: { user: null }, errors: [{ type: "NOT_FOUND", path: ["user"], message: "Could not resolve to a User with the login of 'nobody-here'." }] };
const resetIn = (s: number) => String(Math.floor(NOW / 1000) + s);

beforeEach(() => { __resetLimiters(); });
afterEach(() => { vi.useRealTimers(); });

describe("collectGithub", () => {
  it("запит профілю, запит командної роботи і факти за договором", async () => {
    const { fetchImpl, calls } = mockFetch((_u, _i, body) => json(isTeam(body) ? TEAM : USER));
    const r = await collectGithub("Test-Dev", ctxWith(fetchImpl, env));
    expect(r).toEqual({ ok: true, facts: {
      createdAt: "2019-04-01T10:00:00Z", followers: 250, stars: 150, commits12m: 812, reviews12m: 37,
      mergedPrsElsewhere: 20,   // 40 × 2/4 чужих власників (регістр логіна не важить)
      reposPushed12m: 2, reposWithSite: 1,
      teamStars: 9000, teamCommits: 25,   // acme/protocol: 15 + 10 комітів; свій, форк і 3 коміти не рахуються
    } });
    expect(calls).toHaveLength(2);
    const c = calls[0]!;
    expect(c.url.toString()).toBe("https://api.github.com/graphql");
    expect(c.init.method).toBe("POST");
    expect(new Headers(c.init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    const body = c.body as { query: string; variables: { login: string } };
    expect(body.variables).toEqual({ login: "test-dev" });
    expect(body.query).toContain("pullRequests(states:MERGED,first:100");
    expect(body.query).toContain("isFork:false");
  });

  it("без злитих PR частка 0, а не NaN", async () => {
    const empty = structuredClone(USER);
    empty.data.user.pullRequests = { totalCount: 0, nodes: [] };
    const { fetchImpl } = mockFetch(() => json(empty));
    const r = await collectGithub("test-dev", ctxWith(fetchImpl, env));
    expect(r).toMatchObject({ ok: true, facts: { mergedPrsElsewhere: 0 } });
  });

  it("без GITHUB_TOKEN: not configured і жодного запиту", async () => {
    const { fetchImpl, calls } = mockFetch(() => json(USER));
    expect(await collectGithub("test-dev", ctxWith(fetchImpl, {}))).toEqual({ ok: false, gap: "not configured: GITHUB_TOKEN" });
    expect(calls).toHaveLength(0);
  });

  it("немає такого користувача: прогалина", async () => {
    const { fetchImpl } = mockFetch(() => json(NOT_FOUND));
    expect(await collectGithub("nobody-here", ctxWith(fetchImpl, env))).toEqual({ ok: false, gap: "github: user not found" });
  });

  it("збій GraphQL на боці GitHub (помилка без type) повторюється, і факти приходять", async () => {
    const BROKEN = { data: { user: null }, errors: [{ message: "Something went wrong while executing your query on 2026-09-12T09:59:27Z." }] };
    let n = 0;
    const { fetchImpl, calls } = mockFetch(() => json(++n <= 2 ? BROKEN : USER));
    const r = await collectGithub("test-dev", ctxWith(fetchImpl, env));
    expect(r).toMatchObject({ ok: true, facts: { followers: 250 } });
    expect(calls).toHaveLength(4);   // 2 збої, профіль, командна робота
  });

  it("збій GraphQL на боці GitHub щоразу: прогалина після повторів, а не 'no user'", async () => {
    const BROKEN = { data: { user: null }, errors: [{ message: "Something went wrong while executing your query." }] };
    const { fetchImpl, calls } = mockFetch(() => json(BROKEN));
    expect(await collectGithub("test-dev", ctxWith(fetchImpl, env)))
      .toEqual({ ok: false, gap: "github: GraphQL failed on GitHub's side after 3 attempt(s)" });
    expect(calls).toHaveLength(3);
  });

  it("збій GraphQL на боці GitHub: повтор, що не встигне до межі збору, не починається", async () => {
    const BROKEN = { data: { user: null }, errors: [{ message: "Something went wrong while executing your query." }] };
    const { fetchImpl, calls } = mockFetch(() => json(BROKEN));
    const ctx = ctxWith(fetchImpl, env, { deadlineAt: NOW + 5_000 });
    expect(await collectGithub("test-dev", ctx)).toEqual({ ok: false, gap: "github: GraphQL failed on GitHub's side after 1 attempt(s)" });
    expect(calls).toHaveLength(1);
  });

  it("невалідний логін: прогалина без запиту", async () => {
    const { fetchImpl, calls } = mockFetch(() => json(USER));
    expect(await collectGithub("bad login", ctxWith(fetchImpl, env))).toEqual({ ok: false, gap: "github: invalid login" });
    expect(calls).toHaveLength(0);
  });

  it("401: прогалина без токена в тексті", async () => {
    const { fetchImpl } = mockFetch(() => json({ message: "Bad credentials" }, 401));
    const r = await collectGithub("test-dev", ctxWith(fetchImpl, env));
    expect(r).toEqual({ ok: false, gap: "github: GitHub rejected the token (HTTP 401)" });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("502, потім відповідь: повтор після паузи", async () => {
    let n = 0;
    const { fetchImpl } = mockFetch(() => (++n === 1 ? json({}, 502) : json(USER)));
    const ctx = ctxWith(fetchImpl, env);
    const r = await collectGithub("test-dev", ctx);
    expect(r.ok).toBe(true);
    expect(n).toBe(3);
    expect(ctx.sleeps).toEqual([1_000]);
  });

  it("постійні 5xx: прогалина після повторів", async () => {
    const { fetchImpl, calls } = mockFetch(() => json({}, 503));
    const r = await collectGithub("test-dev", ctxWith(fetchImpl, env));
    expect(r).toEqual({ ok: false, gap: "github: GitHub HTTP 503" });
    expect(calls).toHaveLength(3);
  });
});

describe("командна робота (v7)", () => {
  it("рахує лише чужі не-форки від TEAM_MIN_COMMITS комітів за всі роки", () => {
    expect(TEAM_MIN_COMMITS).toBe(20);
    expect(teamWork(TEAM.data.user, "test-dev")).toEqual({ teamStars: 9000, teamCommits: 25 });
    expect(teamWork(null, "test-dev")).toEqual({ teamStars: 0, teamCommits: 0 });
  });

  it("збій запиту командної роботи не робить GitHub прогалиною", async () => {
    const { fetchImpl } = mockFetch((_u, _i, body) => (isTeam(body) ? json({}, 404) : json(USER)));
    const r = await collectGithub("test-dev", ctxWith(fetchImpl, env));
    expect(r.ok).toBe(true);
    expect(r.ok && "teamStars" in r.facts).toBe(false);
  });

  it("не встигає до межі збору: без запиту командної роботи", async () => {
    const { fetchImpl, calls } = mockFetch((_u, _i, body) => json(isTeam(body) ? TEAM : USER));
    const r = await collectGithub("test-dev", ctxWith(fetchImpl, env, { deadlineAt: NOW + 3_000 }));
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("запит іде від року створення акаунта, не більше 10 років", () => {
    const q = teamQuery("2023-05-01T00:00:00Z", NOW);
    expect(q).toContain("y2023: contributionsCollection(from:\"2023-01-01T00:00:00Z\"");
    expect(q).not.toContain("y2022");
    const old = teamQuery("2008-01-01T00:00:00Z", Date.parse("2026-06-01T00:00:00Z"));
    expect(old).toContain("y2017:");
    expect(old).not.toContain("y2016:");
  });
});

describe("collectGithub: ліміт GitHub", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"], now: NOW }); });
  const settle = async <T>(p: Promise<T>): Promise<T> => { p.catch(() => undefined); await vi.runAllTimersAsync(); return p; };

  it("403 з x-ratelimit-remaining 0 і скиданням за 10 с: чекає через бюджет і пробує ще раз", async () => {
    const starts: number[] = [];
    const t0 = performance.now();
    const { fetchImpl } = mockFetch(() => {
      starts.push(performance.now() - t0);
      return starts.length === 1
        ? json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": resetIn(10) })
        : json(USER);
    });
    const r = await settle(collectGithub("test-dev", ctxWith(fetchImpl, env)));
    expect(r.ok).toBe(true);
    expect(starts.slice(0, 2)).toEqual([0, 11_000]);
  });

  it("GraphQL 200 з RATE_LIMITED теж ліміт", async () => {
    let n = 0;
    const { fetchImpl } = mockFetch(() => (++n === 1
      ? json({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }, 200,
        { "x-ratelimit-remaining": "0", "x-ratelimit-reset": resetIn(5) })
      : json(USER)));
    const r = await settle(collectGithub("test-dev", ctxWith(fetchImpl, env)));
    expect(r.ok).toBe(true);
    expect(n).toBe(3);
  });

  it("скидання далі за 15 с: одразу прогалина, без сну", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": resetIn(30) }));
    const t0 = performance.now();
    const r = await settle(collectGithub("test-dev", ctxWith(fetchImpl, env)));
    expect(r).toMatchObject({ ok: false, gap: expect.stringMatching(/^github: GitHub rate limit \(resets in 31 s\)/) });
    expect(calls).toHaveLength(1);
    expect(GITHUB_MAX_WAIT_MS).toBe(15_000);
    expect(performance.now() - t0).toBe(0);
  });

  it("429 з Retry-After 600: прогалина, а бюджет api.github.com для інших стоїть не довше 15 с", async () => {
    const starts: number[] = [];
    const t0 = performance.now();
    const { fetchImpl } = mockFetch(() => {
      starts.push(performance.now() - t0);
      return starts.length === 1 ? json({ message: "secondary rate limit" }, 429, { "retry-after": "600" }) : json(USER);
    });
    const first = await settle(collectGithub("test-dev", ctxWith(fetchImpl, env)));
    expect(first).toMatchObject({ ok: false, gap: expect.stringMatching(/rate limit/) });
    const second = await settle(collectGithub("other-dev", ctxWith(fetchImpl, env)));
    expect(second.ok).toBe(true);
    expect(starts[1]!).toBeLessThanOrEqual(GITHUB_MAX_WAIT_MS);
  });

  it("ліміт удруге поспіль: прогалина", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      json({ message: "rate" }, 429, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": resetIn(10) }));
    const r = await settle(collectGithub("test-dev", ctxWith(fetchImpl, env)));
    expect(r).toMatchObject({ ok: false, gap: expect.stringMatching(/rate limit/) });
    expect(calls).toHaveLength(2);
  });

  it("403 без ознак ліміту: звичайна відмова, без очікування", () => {
    expect(rateLimitWaitMs(403, new Headers({ "x-ratelimit-remaining": "4999" }), NOW)).toBeNull();
    expect(rateLimitWaitMs(403, new Headers({ "retry-after": "7" }), NOW)).toBe(7_000);
    expect(rateLimitWaitMs(200, new Headers(), NOW)).toBeNull();
  });
});
