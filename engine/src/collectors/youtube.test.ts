import { beforeEach, describe, expect, it } from "vitest";
import { __resetLimiters } from "../limits.js";
import { ctxWith, json, mockFetch, NOW } from "./testkit.js";
import { channelSelector, collectYoutube } from "./youtube.js";

const KEY = "AIzaSyTestSecretKey000";
const env = { YOUTUBE_KEY: KEY };
const CHANNEL_ID = "UCabcdefghijklmnopqrstuv";
const UPLOADS = "UUabcdefghijklmnopqrstuv";
const DAY = 86_400_000;

// Синтетичні відповіді Data API v3 у формі справжніх.
const channel = (statistics: Record<string, unknown>) => json({
  kind: "youtube#channelListResponse", etag: "e1", pageInfo: { totalResults: 1, resultsPerPage: 5 },
  items: [{ kind: "youtube#channel", etag: "e2", id: CHANNEL_ID,
    contentDetails: { relatedPlaylists: { likes: "", uploads: UPLOADS } }, statistics }],
});
const STATS = { viewCount: "123456", subscriberCount: "5400", hiddenSubscriberCount: false, videoCount: "20" };
// 20 відео раз на 10 днів; у відповіді від найстарішого, щоб перевірити сортування.
const VIDEOS = Array.from({ length: 20 }, (_, i) => ({ id: `vid${String(i).padStart(8, "0")}`, ts: NOW - i * 10 * DAY - 3_600_000 }));
const playlist = () => json({
  kind: "youtube#playlistItemListResponse", pageInfo: { totalResults: 20, resultsPerPage: 50 },
  items: [...VIDEOS].reverse().map((v) => ({ kind: "youtube#playlistItem",
    contentDetails: { videoId: v.id, videoPublishedAt: new Date(v.ts).toISOString() } })),
});
const videos = (u: URL) => json({
  kind: "youtube#videoListResponse",
  items: (u.searchParams.get("id") ?? "").split(",").map((id) => ({ kind: "youtube#video", id,
    statistics: { viewCount: String(1000 * (Number(id.slice(3)) + 1)), likeCount: "10", commentCount: "2" } })),
});

function api(over: { channels?: (u: URL) => Response; playlistItems?: (u: URL) => Response } = {}) {
  return mockFetch((u) => {
    const path = u.pathname.split("/").pop();
    if (path === "channels") return (over.channels ?? (() => channel(STATS)))(u);
    if (path === "playlistItems") return (over.playlistItems ?? playlist)(u);
    if (path === "videos") return videos(u);
    return json({ error: { code: 404 } }, 404);
  });
}

beforeEach(() => { __resetLimiters(); });

describe("collectYoutube", () => {
  it("канал → завантаження → 15 найсвіжіших відео", async () => {
    const { fetchImpl, calls } = api();
    const r = await collectYoutube("@Test.Channel", ctxWith(fetchImpl, env));
    expect(r).toEqual({ ok: true, facts: {
      channelId: CHANNEL_ID, subscribers: 5400, hiddenSubscribers: false,
      avgViewsRecent: 8000,   // (1..15) × 1000 / 15
      videos90d: 9,           // 0, 10, …, 80 днів тому
    } });
    expect(calls.map((c) => c.url.pathname)).toEqual(["/youtube/v3/channels", "/youtube/v3/playlistItems", "/youtube/v3/videos"]);
    const [ch, pl, vd] = calls.map((c) => c.url.searchParams);
    expect(ch!.get("forHandle")).toBe("@test.channel");
    expect(ch!.get("part")).toBe("statistics,contentDetails");
    expect(ch!.get("key")).toBe(KEY);
    expect(pl!.get("playlistId")).toBe(UPLOADS);
    expect(pl!.get("maxResults")).toBe("50");
    expect(vd!.get("id")!.split(",")).toEqual(VIDEOS.slice(0, 15).map((v) => v.id));
  });

  it("channel id UC… іде як id, а не forHandle", async () => {
    expect(channelSelector(CHANNEL_ID)).toEqual({ id: CHANNEL_ID });
    expect(channelSelector("SomeHandle")).toEqual({ forHandle: "@somehandle" });
    expect(channelSelector("bad handle")).toBeNull();
    expect(channelSelector("ab")).toBeNull();
  });

  it("нелатинські хендли YouTube приймаються й ідуть у forHandle", async () => {
    expect(channelSelector("@Привіт_Канал")).toEqual({ forHandle: "@привіт_канал" });
    expect(channelSelector("@日本語チャンネル")).toEqual({ forHandle: "@日本語チャンネル" });
    expect(channelSelector("@مرحبا.قناة")).toEqual({ forHandle: "@مرحبا.قناة" });
    expect(channelSelector("@name/../x")).toBeNull();
    const { fetchImpl, calls } = api();
    expect((await collectYoutube("@Привіт_Канал", ctxWith(fetchImpl, env))).ok).toBe(true);
    expect(calls[0]!.url.searchParams.get("forHandle")).toBe("@привіт_канал");
  });

  it("приховані підписники: subscribers null і hiddenSubscribers true", async () => {
    const { fetchImpl } = api({ channels: () => channel({ viewCount: "999", hiddenSubscriberCount: true, videoCount: "20" }) });
    const r = await collectYoutube(CHANNEL_ID, ctxWith(fetchImpl, env));
    expect(r).toMatchObject({ ok: true, facts: { subscribers: null, hiddenSubscribers: true, avgViewsRecent: 8000 } });
  });

  it("канал без відео: плейлист не питаємо, videos90d 0, середнє null", async () => {
    const { fetchImpl, calls } = api({ channels: () => channel({ ...STATS, videoCount: "0" }) });
    const r = await collectYoutube("@empty_channel", ctxWith(fetchImpl, env));
    expect(r).toMatchObject({ ok: true, facts: { subscribers: 5400, videos90d: 0, avgViewsRecent: null } });
    expect(calls).toHaveLength(1);
  });

  it("збій плейлиста лишає null у відео-полях, підписники є", async () => {
    const { fetchImpl } = api({ playlistItems: () => json({ error: { code: 404, message: "playlistNotFound" } }, 404) });
    const r = await collectYoutube("@test.channel", ctxWith(fetchImpl, env));
    expect(r).toEqual({ ok: true, facts: { channelId: CHANNEL_ID, subscribers: 5400, hiddenSubscribers: false, avgViewsRecent: null, videos90d: null } });
  });

  it("без YOUTUBE_KEY: not configured і жодного запиту", async () => {
    const { fetchImpl, calls } = api();
    expect(await collectYoutube("@test.channel", ctxWith(fetchImpl, {}))).toEqual({ ok: false, gap: "not configured: YOUTUBE_KEY" });
    expect(calls).toHaveLength(0);
  });

  it("канал не знайдено: прогалина", async () => {
    const { fetchImpl } = api({ channels: () => json({ kind: "youtube#channelListResponse", pageInfo: { totalResults: 0 } }) });
    expect(await collectYoutube("@nobody", ctxWith(fetchImpl, env))).toEqual({ ok: false, gap: "youtube: channel not found" });
  });

  it("403 (квота): прогалина без ключа в тексті", async () => {
    const { fetchImpl } = api({ channels: () => json({ error: { code: 403, errors: [{ reason: "quotaExceeded" }] } }, 403) });
    const r = await collectYoutube("@test.channel", ctxWith(fetchImpl, env));
    expect(r).toEqual({ ok: false, gap: "youtube: channels.list failed (HTTP 403)" });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("мережевий збій з адресою в тексті: ключ замасковано", async () => {
    const { fetchImpl } = mockFetch((u) => { throw new TypeError(`fetch failed: ${u.toString()}`); });
    const r = await collectYoutube("@test.channel", ctxWith(fetchImpl, env));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
});
