import { fetchJson } from "../http.js";
import type { Fetched, YoutubeFacts } from "../types.js";
import {
  collect, DAY_MS, describeError, fetchOpts, GapError, notConfigured, nowMs, num, type CollectorContext,
} from "./context.js";

/**
 * YouTube через Data API v3 (ключ YOUTUBE_KEY): channels.list → плейлист завантажень →
 * playlistItems.list (50) → videos.list для 15 найсвіжіших. ~3 одиниці квоти на канал.
 * Сторінки YouTube не читаємо.
 */
const API = "https://www.googleapis.com/youtube/v3";
const RECENT = 15;

type Channel = {
  id?: string;
  statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean; videoCount?: string };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
};
type PlaylistItem = { contentDetails?: { videoId?: string; videoPublishedAt?: string } };
type Video = { id?: string; statistics?: { viewCount?: string } };

/**
 * §2: `@handle` нижнім регістром або channel id `UC…` як є. Хендли YouTube бувають
 * будь-якою писемністю: літери й цифри Unicode, "_", "-", ".", 3–30 символів.
 */
export function channelSelector(handleOrId: string): { id: string } | { forHandle: string } | null {
  const v = handleOrId.trim();
  if (/^UC[A-Za-z0-9_-]{22}$/.test(v)) return { id: v };
  const h = v.replace(/^@/, "").normalize("NFC").toLowerCase();
  return /^[\p{L}\p{M}\p{N}._-]{3,30}$/u.test(h) ? { forHandle: `@${h}` } : null;
}

const url = (path: string, params: Record<string, string>, key: string): string =>
  `${API}/${path}?${new URLSearchParams({ ...params, key })}`;

export async function collectYoutube(handleOrId: string, ctx: CollectorContext): Promise<Fetched<YoutubeFacts>> {
  return collect("youtube", ctx, async () => {
    const key = ctx.env.YOUTUBE_KEY;
    if (!key) throw notConfigured("YOUTUBE_KEY");
    const selector = channelSelector(handleOrId);
    if (!selector) throw new GapError("invalid channel handle or id");
    const opts = fetchOpts(ctx, { retries: 1 });
    const get = <T>(path: string, params: Record<string, string>): Promise<T> =>
      fetchJson<T>(url(path, params, key), { signal: ctx.signal }, opts);

    let channel: Channel | undefined;
    try {
      const res = await get<{ items?: Channel[] }>("channels", { part: "statistics,contentDetails", ...selector });
      channel = res?.items?.[0];
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      throw new GapError(`channels.list failed (${describeError(e)})`);
    }
    if (!channel?.id) throw new GapError("channel not found");

    const hidden = channel.statistics?.hiddenSubscriberCount === true;
    const facts: YoutubeFacts = {
      channelId: channel.id,
      subscribers: hidden ? null : num(channel.statistics?.subscriberCount),
      hiddenSubscribers: hidden,
      avgViewsRecent: null,
      videos90d: null,
    };
    if (num(channel.statistics?.videoCount) === 0) return { ...facts, videos90d: 0 };
    const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) return facts;

    // Далі збої лишають null у своїх полях: підписники вже є, прогалина на весь канал була б гіршою.
    let items: PlaylistItem[];
    try {
      const res = await get<{ items?: PlaylistItem[] }>("playlistItems",
        { part: "contentDetails", playlistId: uploads, maxResults: "50" });
      items = res?.items ?? [];
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      return facts;
    }
    const dated = items
      .map((i) => ({ id: i.contentDetails?.videoId, ts: Date.parse(i.contentDetails?.videoPublishedAt ?? "") }))
      .filter((v): v is { id: string; ts: number } => !!v.id && !Number.isNaN(v.ts))
      .sort((a, b) => b.ts - a.ts);
    const now = nowMs(ctx);
    facts.videos90d = dated.filter((v) => v.ts > now - 90 * DAY_MS).length;
    const recent = dated.slice(0, RECENT).map((v) => v.id);
    if (recent.length === 0) return facts;

    try {
      const res = await get<{ items?: Video[] }>("videos", { part: "statistics", id: recent.join(",") });
      const views = (res?.items ?? []).map((v) => num(v.statistics?.viewCount)).filter((n): n is number => n !== null);
      facts.avgViewsRecent = views.length ? views.reduce((a, b) => a + b, 0) / views.length : null;
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
    }
    return facts;
  });
}
