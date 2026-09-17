import { fetchJson } from "../http.js";
import { backoffFor } from "../limits.js";
import type { Collected, XFacts } from "../types.js";
import {
  collect, DAY_MS, describeError, fetchOpts, fitsDeadline, GapError, isEmpty, notConfigured, nowMs, num,
  type CollectorContext,
} from "./context.js";

/**
 * X через 6551 (ai.6551.io). API X не використовуємо (docs/specs, §джерела).
 * Порожнє `data` у відповіді 6551 означає ліміт: чекаємо через бюджет "6551" і повторюємо.
 */
const BASE = "https://ai.6551.io/open/";
/**
 * Скільки разів питати, поки `data` порожнє. Дослідження питало 5 разів з паузами до 20 с;
 * у дедлайн людини (45 с, три людини разом) влазять лише 3 спроби з паузами 2 і 4 с.
 */
export const EMPTY_ATTEMPTS = 3;
const EMPTY_BACKOFF_MS = [2_000, 4_000];
/** Оцінка одного виклику 6551 для рішення «чи встигне повтор» (живий збір: 1–4 с на виклик). */
export const X_CALL_ESTIMATE_MS = 4_000;

type Envelope = { data?: unknown; success?: boolean; error?: string };

/**
 * Пост у відповіді twitter_user_tweets (поля з нулем 6551 просто пропускає).
 *
 * 17.09, вимір: `conversationId` цей виклик НЕ віддає (жива відповідь для @toly має лише
 * createdAt, favoriteCount, id, media, quoteCount, replyCount, retweetCount, retweetedStatus,
 * text, userFollowers, userIdStr, userName, userScreenName, viewCount). Ретвіт видно по
 * `retweetedStatus` (там пост автора-джерела). Поле лишаємо необов'язковим: якщо 6551 почне
 * віддавати його знову, isOwnPost ним скористається.
 */
export type Tweet = {
  id?: string | number; conversationId?: string | number; text?: string; createdAt?: string;
  favoriteCount?: number; retweetCount?: number; replyCount?: number; viewCount?: number;
  /** Є лише в ретвіті: пост, який людина ретвітнула. */
  retweetedStatus?: unknown;
};

type UserInfo = { success?: boolean; followersCount?: number; statusesCount?: number };

/**
 * Один виклик 6551. Повертає `data` або null, якщо воно лишилось порожнім після
 * EMPTY_ATTEMPTS спроб або повтор не встиг би до дедлайну. HTTP-помилки (після
 * повторів fetchJson) летять далі. `signal` знімає і запит, і повтор із черги бюджету.
 */
async function call6551(path: string, body: object, token: string, ctx: CollectorContext, signal = ctx.signal): Promise<unknown> {
  const url = BASE + path;
  for (let attempt = 1; attempt <= EMPTY_ATTEMPTS; attempt++) {
    const res = await fetchJson<Envelope>(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }, fetchOpts(ctx));
    if (!isEmpty(res?.data)) return res.data;
    const wait = EMPTY_BACKOFF_MS[attempt - 1];
    if (wait === undefined || !fitsDeadline(ctx, wait + X_CALL_ESTIMATE_MS)) break;
    // Наступний виклик у бюджеті "6551" (і чужий теж) стане в чергу за цією паузою.
    backoffFor(url, wait);
  }
  return null;
}

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** "Fri Sep 11 09:22:05 +0000 2026" (формат X) або ISO → мс; null, якщо не розібрати. */
export function parseTweetDate(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = /^\w{3} (\w{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2}) (\d{4})$/.exec(s.trim());
  if (m) {
    const month = MONTHS[m[1]!];
    if (month === undefined) return null;
    const offset = (m[6] === "-" ? -1 : 1) * (Number(m[7]) * 60 + Number(m[8])) * 60_000;
    const t = Date.UTC(Number(m[9]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])) - offset;
    return Number.isFinite(t) ? t : null;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/** Ретвіт: 6551 кладе поруч пост-джерело, а текст старих ретвітів починається з "RT @". */
export const isRetweet = (t: Tweet): boolean => t.retweetedStatus != null || (t.text ?? "").startsWith("RT @");

/** Відповідь: лише коли 6551 дав conversationId і він не збігається з id. */
export const isReply = (t: Tweet): boolean =>
  t.id != null && t.conversationId != null && String(t.conversationId) !== String(t.id);

/**
 * Власний пост: не ретвіт і не відповідь (docs/contracts.md §3).
 *
 * До 17.09 правило вимагало `conversationId == id`. Це поле twitter_user_tweets не віддає, тож
 * власним не був НІ ОДИН пост: own, own30d і всі середні виходили нуль чи null у всіх людей, а
 * з ними падав бал X (55 зі 100 балів джерела) і сторінка казала «nothing to score in your X».
 * Сам виклик іде без відповідей (includeReplies за замовчуванням false), тож власний пост це
 * просто «те, що не ретвіт».
 */
export const isOwnPost = (t: Tweet): boolean => t.id != null && !isRetweet(t) && !isReply(t);

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** XFacts з профілю, KOL і постів. Чиста функція: тести звіряють її напряму. */
export function xFacts(info: UserInfo, kolData: unknown, tweets: Tweet[], now: number): XFacts {
  const own = tweets.filter(isOwnPost);
  // Відповіді цей виклик не віддає, а без conversationId їх і не відрізнити: null означає
  // «не знаємо», а не «нуль» (бал не має права спиратись на вигадане число).
  const replies = tweets.some((t) => t.conversationId != null) ? tweets.filter(isReply).length : null;
  const stamps = tweets.map((t) => parseTweetDate(t.createdAt)).filter((t): t is number => t !== null);
  const kol = kolData && typeof kolData === "object" && !Array.isArray(kolData)
    ? num((kolData as { totalCount?: unknown }).totalCount) : null;
  return {
    followers: num(info.followersCount),
    kol,
    kolSourceGap: kol === null,
    fetched: tweets.length,
    own: own.length,
    repliesMade: replies,
    own30d: own.filter((t) => (parseTweetDate(t.createdAt) ?? 0) > now - 30 * DAY_MS).length,
    ownAvgLikesRt: mean(own.map((t) => (num(t.favoriteCount) ?? 0) + (num(t.retweetCount) ?? 0))),
    ownAvgViews: mean(own.map((t) => num(t.viewCount) ?? 0)),
    ownAvgReplies: mean(own.map((t) => num(t.replyCount) ?? 0)),
    daysCovered: stamps.length > 1 ? (Math.max(...stamps) - Math.min(...stamps)) / DAY_MS : null,
  };
}

/** Нік X за §2: без "@", нижній регістр. */
export const normalizeHandle = (h: string): string => h.trim().replace(/^@/, "").toLowerCase();

export async function collectX(handle: string, ctx: CollectorContext): Promise<Collected<XFacts>> {
  return collect("x", ctx, async () => {
    const token = ctx.env.TWITTER_TOKEN;
    if (!token) throw notConfigured("TWITTER_TOKEN");
    const username = normalizeHandle(handle);
    if (!/^[a-z0-9_]{1,30}$/.test(username)) throw new GapError("invalid handle");

    let info: UserInfo;
    try {
      const data = await call6551("twitter_user_info", { username }, token, ctx);
      if (data === null) throw new GapError("6551 returned no profile after retries (rate limit)");
      info = data as UserInfo;
    } catch (e) {
      if (e instanceof GapError || ctx.signal?.aborted) throw e;
      throw new GapError(`profile unavailable (${describeError(e)})`);
    }
    if (info.success === false) throw new GapError("6551 could not load the profile (missing or suspended account)");

    // KOL і пости незалежні: бюджет "6551" сам розводить їх у часі. Обидва під спільним
    // сигналом: коли пости дають прогалину, KOL (у польоті чи в черзі на повтор)
    // скасовується, і після повернення жоден запит не витрачає бали 6551.
    const local = new AbortController();
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, local.signal]) : local.signal;
    try {
      const kolP = call6551("twitter_kol_followers", { username }, token, ctx, signal).catch((e: unknown) => {
        if (ctx.signal?.aborted) throw e;
        return null;   // kolSourceGap
      });
      const tweetsP = (async (): Promise<Tweet[]> => {
        // Акаунт без жодного допису: порожня стрічка тут правда, а не ліміт.
        if (num(info.statusesCount) === 0) return [];
        let data: unknown;
        try {
          data = await call6551("twitter_user_tweets", { username, maxResults: 100, product: "Latest" }, token, ctx, signal);
        } catch (e) {
          if (ctx.signal?.aborted) throw e;
          throw new GapError(`posts unavailable (${describeError(e)})`);
        }
        if (data === null) throw new GapError("6551 returned no posts after retries (rate limit)");
        const list = Array.isArray(data) ? data : (data as { tweets?: unknown }).tweets;
        if (!Array.isArray(list)) throw new GapError("6551 returned posts in an unknown shape");
        return list as Tweet[];
      })();
      // Прогалина постів одразу скасовує KOL, не чекаючи його відповіді.
      tweetsP.catch(() => local.abort(new GapError("posts failed")));
      const [kolData, tweets] = await Promise.all([kolP, tweetsP]);
      return xFacts(info, kolData, tweets, nowMs(ctx));
    } finally {
      local.abort(new GapError("x collector returned"));
    }
  });
}
