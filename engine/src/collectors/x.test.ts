import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetLimiters } from "../limits.js";
import { ctxWith, json, mockFetch, NOW } from "./testkit.js";
import { collectX, EMPTY_ATTEMPTS, isOwnPost, parseTweetDate, X_CALL_ESTIMATE_MS } from "./x.js";

const TOKEN = "tw-secret-token-1";
const env = { TWITTER_TOKEN: TOKEN };

// Синтетичні відповіді у формі справжніх відповідей 6551 (поля з нулем 6551 пропускає).
const INFO = {
  data: { success: true, userId: "1000001", screenName: "test_builder", name: "Test Builder",
    followersCount: 4321, friendsCount: 300, statusesCount: 1200, verified: false },
  success: true, usage: { cost: "1", quota: "0" },
};
const KOL = { data: { totalCount: 7, users: [{ id: 1, idStr: "1", screenName: "kol_a", followersCount: 90000 }] }, success: true };
const TWEETS = {
  data: [
    { id: "1900000000000000010", conversationId: "1900000000000000010", text: "shipping the indexer today",
      createdAt: "Thu Sep 10 08:00:00 +0000 2026", favoriteCount: 20, retweetCount: 4, replyCount: 3, viewCount: 1000 },
    { id: "1900000000000000009", conversationId: "1900000000000000009", text: "a thread on fees",
      createdAt: "Mon Aug 03 10:00:00 +0000 2026", favoriteCount: 10, replyCount: 1, viewCount: 500 },
    { id: "1900000000000000008", conversationId: "1800000000000000001", text: "@someone agreed",
      createdAt: "Sat Sep 05 10:00:00 +0000 2026", favoriteCount: 2, viewCount: 40 },
    { id: "1900000000000000007", conversationId: "1900000000000000007", text: "RT @other: big news",
      createdAt: "Fri Sep 04 10:00:00 +0000 2026", retweetCount: 50, viewCount: 9000 },
    { id: "1900000000000000006", conversationId: "1900000000000000006", text: "gm",
      createdAt: "Wed Jun 10 12:00:00 +0200 2026" },
  ],
  success: true,
};

type Replies = { info?: () => Response; kol?: () => Response; tweets?: () => Response };
function api(r: Replies = {}) {
  return mockFetch((url) => {
    const path = url.pathname.split("/").pop();
    if (path === "twitter_user_info") return (r.info ?? (() => json(INFO)))();
    if (path === "twitter_kol_followers") return (r.kol ?? (() => json(KOL)))();
    if (path === "twitter_user_tweets") return (r.tweets ?? (() => json(TWEETS)))();
    return json({ error: "unknown" }, 404);
  });
}

beforeEach(() => { __resetLimiters(); });
afterEach(() => { vi.useRealTimers(); });

describe("collectX: розбір", () => {
  it("рахує факти за договором: власні пости, відповіді, середні, покриття", async () => {
    const { fetchImpl, calls } = api();
    const r = await collectX("@Test_Builder", ctxWith(fetchImpl, env));
    expect(r).toEqual({ ok: true, facts: {
      followers: 4321, kol: 7, kolSourceGap: false,
      fetched: 5, own: 3, repliesMade: 1, own30d: 1,
      ownAvgLikesRt: 34 / 3, ownAvgViews: 500, ownAvgReplies: 4 / 3,
      daysCovered: 92 - 2 / 24,
    } });
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.url.origin).toBe("https://ai.6551.io");
      expect(c.init.method).toBe("POST");
      expect(new Headers(c.init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect((c.body as { username: string }).username).toBe("test_builder");
    }
    expect(calls.find((c) => c.url.pathname.endsWith("twitter_user_tweets"))!.body)
      .toEqual({ username: "test_builder", maxResults: 100, product: "Latest" });
  });

  it("власний пост: conversationId == id і не ретвіт", () => {
    expect(isOwnPost({ id: "5", conversationId: "5", text: "hello" })).toBe(true);
    expect(isOwnPost({ id: "5", conversationId: "4", text: "hello" })).toBe(false);
    expect(isOwnPost({ id: "5", conversationId: "5", text: "RT @a: hi" })).toBe(false);
    expect(isOwnPost({ id: "5", text: "no conversation id" })).toBe(false);
  });

  it("дата X зі зсувом часового поясу", () => {
    expect(parseTweetDate("Fri Sep 11 09:22:05 +0000 2026")).toBe(Date.UTC(2026, 8, 11, 9, 22, 5));
    expect(parseTweetDate("Wed Jun 10 12:00:00 +0200 2026")).toBe(Date.UTC(2026, 5, 10, 10, 0, 0));
    expect(parseTweetDate("2026-09-01T00:00:00Z")).toBe(Date.UTC(2026, 8, 1));
    expect(parseTweetDate("not a date")).toBeNull();
    expect(parseTweetDate(undefined)).toBeNull();
  });

  it("акаунт без жодного допису: стрічку не питаємо, середні null, а не 0", async () => {
    const { fetchImpl, calls } = api({ info: () => json({ ...INFO, data: { ...INFO.data, statusesCount: 0 } }) });
    const r = await collectX("test_builder", ctxWith(fetchImpl, env));
    expect(r).toMatchObject({ ok: true, facts: { fetched: 0, own: 0, own30d: 0, ownAvgLikesRt: null,
      ownAvgViews: null, ownAvgReplies: null, daysCovered: null } });
    expect(calls.some((c) => c.url.pathname.endsWith("twitter_user_tweets"))).toBe(false);
  });
});

describe("collectX: прогалини", () => {
  it("без TWITTER_TOKEN: not configured і жодного запиту", async () => {
    const { fetchImpl, calls } = api();
    expect(await collectX("test_builder", ctxWith(fetchImpl, {}))).toEqual({ ok: false, gap: "not configured: TWITTER_TOKEN" });
    expect(calls).toHaveLength(0);
  });

  it("профіль з HTTP-помилкою: прогалина без токена в тексті", async () => {
    const { fetchImpl } = api({ info: () => json({ error: "invalid token", success: false }, 401) });
    const r = await collectX("test_builder", ctxWith(fetchImpl, env));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.gap).toMatch(/^x: profile unavailable \(HTTP 401\)/);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("6551 не знайшов профіль (success:false у data): прогалина", async () => {
    const { fetchImpl, calls } = api({ info: () => json({ data: { success: false, error: "获取用户信息失败" }, success: true }) });
    const r = await collectX("test_builder", ctxWith(fetchImpl, env));
    expect(r).toMatchObject({ ok: false, gap: expect.stringMatching(/^x: 6551 could not load the profile/) });
    expect(calls).toHaveLength(1);
  });

  it("невдалий виклик KOL: kolSourceGap, решта фактів є", async () => {
    const { fetchImpl } = api({ kol: () => json({ error: "no" }, 404) });
    const r = await collectX("test_builder", ctxWith(fetchImpl, env));
    expect(r).toMatchObject({ ok: true, facts: { kol: null, kolSourceGap: true, followers: 4321, own: 3 } });
  });

  it("KOL з нулем знайомих: це 0, а не прогалина", async () => {
    const { fetchImpl } = api({ kol: () => json({ data: { totalCount: 0, users: [] }, success: true }) });
    const r = await collectX("test_builder", ctxWith(fetchImpl, env));
    expect(r).toMatchObject({ ok: true, facts: { kol: 0, kolSourceGap: false } });
  });

  it("невалідний нік: прогалина без запиту", async () => {
    const { fetchImpl, calls } = api();
    expect(await collectX("bad handle!", ctxWith(fetchImpl, env))).toEqual({ ok: false, gap: "x: invalid handle" });
    expect(calls).toHaveLength(0);
  });

  it("скасований збір кидає, а не пише прогалину", async () => {
    const { fetchImpl } = api();
    const ac = new AbortController();
    ac.abort();
    await expect(collectX("test_builder", ctxWith(fetchImpl, env, { signal: ac.signal }))).rejects.toBeDefined();
  });
});

describe("collectX: порожнє data = ліміт, у межах дедлайну", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"], now: NOW }); });
  const settle = async <T>(p: Promise<T>): Promise<T> => { p.catch(() => undefined); await vi.runAllTimersAsync(); return p; };
  const clock = { now: () => Date.now() };

  it("не більше трьох спроб з паузою бюджету 2 і 4 с, далі прогалина", async () => {
    const starts: number[] = [];
    const t0 = Date.now();
    const { fetchImpl } = api({ info: () => { starts.push(Date.now() - t0); return json({ success: true }); } });
    const r = await settle(collectX("test_builder", ctxWith(fetchImpl, env, clock)));
    expect(r).toMatchObject({ ok: false, gap: expect.stringMatching(/^x: 6551 returned no profile/) });
    expect(EMPTY_ATTEMPTS).toBe(3);
    expect(starts).toEqual([0, 2_000, 6_000]);
  });

  it("повтор, що не встигне до дедлайну, не робиться", async () => {
    let n = 0;
    const { fetchImpl } = api({ info: () => { n++; return json({ success: true }); } });
    // 2 с паузи + оцінка виклику не влазять у 5 с до дедлайну.
    const r = await settle(collectX("test_builder", ctxWith(fetchImpl, env, { ...clock, deadlineAt: NOW + 5_000 })));
    expect(r).toMatchObject({ ok: false, gap: expect.stringMatching(/^x: 6551 returned no profile/) });
    expect(n).toBe(1);
    expect(2_000 + X_CALL_ESTIMATE_MS).toBeGreaterThan(5_000);
  });

  it("дедлайн пускає перший повтор і відсікає другий", async () => {
    let n = 0;
    const { fetchImpl } = api({ info: () => { n++; return json({ success: true }); } });
    const deadlineAt = NOW + 2_000 + 4_000 + X_CALL_ESTIMATE_MS - 1;
    await settle(collectX("test_builder", ctxWith(fetchImpl, env, { ...clock, deadlineAt })));
    expect(n).toBe(2);
  });

  it("порожнє data двічі, потім відповідь: факти є", async () => {
    let n = 0;
    const { fetchImpl } = api({ info: () => (++n <= 2 ? json({ data: {}, success: true }) : json(INFO)) });
    const r = await settle(collectX("test_builder", ctxWith(fetchImpl, env, clock)));
    expect(n).toBe(3);
    expect(r).toMatchObject({ ok: true, facts: { followers: 4321 } });
  });

  it("стрічка лишилась порожньою після повторів: прогалина, а не нулі", async () => {
    let n = 0;
    const { fetchImpl } = api({ tweets: () => { n++; return json({ data: [], success: true }); } });
    const r = await settle(collectX("test_builder", ctxWith(fetchImpl, env, clock)));
    expect(n).toBe(EMPTY_ATTEMPTS);
    expect(r).toMatchObject({ ok: false, gap: expect.stringMatching(/^x: 6551 returned no posts/) });
  });

  it("порожній KOL після повторів: kolSourceGap", async () => {
    const { fetchImpl } = api({ kol: () => json({ data: null, success: true }) });
    const r = await settle(collectX("test_builder", ctxWith(fetchImpl, env, clock)));
    expect(r).toMatchObject({ ok: true, facts: { kol: null, kolSourceGap: true } });
  });

  it("стрічка впала, поки KOL чекає повтору: повтор KOL не стартує після повернення", async () => {
    let kolCalls = 0;
    const { fetchImpl } = api({
      kol: () => { kolCalls++; return json({ data: {}, success: true }); },
      tweets: () => json({ error: "invalid token", success: false }, 401),
    });
    const r = await settle(collectX("test_builder", ctxWith(fetchImpl, env, clock)));
    expect(r).toMatchObject({ ok: false, gap: expect.stringMatching(/^x: posts unavailable \(HTTP 401\)/) });
    await vi.runAllTimersAsync();
    expect(kolCalls).toBe(1);
  });
});

describe("collectX: без запитів-сиріт", () => {
  it("стрічка впала: KOL, що ще в польоті, скасовується до повернення", async () => {
    let kolSignal: AbortSignal | null | undefined;
    const { fetchImpl } = mockFetch((url, init) => {
      const path = url.pathname.split("/").pop();
      if (path === "twitter_user_info") return json(INFO);
      if (path === "twitter_user_tweets") return json({ error: "query failed" }, 401);
      kolSignal = init.signal;
      return new Promise<Response>((_res, rej) => {
        init.signal?.addEventListener("abort", () => rej(init.signal!.reason), { once: true });
      });
    });
    const r = await collectX("test_builder", ctxWith(fetchImpl, env));
    expect(r).toMatchObject({ ok: false, gap: expect.stringMatching(/^x: posts unavailable/) });
    expect(kolSignal?.aborted).toBe(true);
  });
});

it("NOW у фікстурах: 12.09.2026", () => { expect(new Date(NOW).toISOString()).toBe("2026-09-12T12:00:00.000Z"); });
