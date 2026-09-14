import { audit } from "@/lib/audit";
import { handleIntroCallback } from "@/lib/crm/intro-callbacks";
import { db } from "@/lib/db";
import { cleanText, hourLabel, shortDate } from "@/lib/digest/format";
import { BOT_JOBS_LIMIT, type RecentJob, recentSentJobs } from "@/lib/digest/history";
import { type JobsDb, jobsDb } from "@/lib/jobs-db";
import { jobVia } from "@/lib/jobs/link";
import type { Channel } from "./channel";
import { answerCallbackQuery, escapeHtml, sendMessage, type SendDeps } from "./send";

/**
 * Бот @nextcryptojob_bot: /start, /help, /jobs, /stop і гачок для кнопок.
 * Лише приватні чати: у групі бот мовчить. Людина в приватному чаті має
 * chat.id = from.id, і це той самий id, що лежить у users.telegram_id після
 * входу через Telegram. Усе, що бот читає про людину, він шукає лише за цим id:
 * чужих вакансій /jobs не покаже.
 * Список команд і опис бота в Telegram ставить scripts/telegram-bot-setup.mjs.
 */

export type TgUser = { id: number; is_bot?: boolean; username?: string; first_name?: string };
export type TgChat = { id: number; type: string };
export type TgMessage = { message_id: number; chat: TgChat; from?: TgUser; text?: string };
export type TgCallbackQuery = { id: string; from: TgUser; data?: string; message?: TgMessage };
export type TgUpdate = { update_id: number; message?: TgMessage; callback_query?: TgCallbackQuery };

export type BotContext = {
  token: string | undefined;
  /** Адреса сайту для посилань (походження запиту вебхука). */
  origin: string;
  deps?: SendDeps;
  /** База вакансій для /jobs; за замовчуванням прив'язка Worker. */
  jobs?: () => JobsDb;
};

function link(origin: string, path: string): string {
  const url = new URL(path, origin);
  return `<a href="${escapeHtml(url.toString())}">${escapeHtml(url.host + url.pathname)}</a>`;
}

/** Посилання зі своїм словом замість адреси. */
function named(origin: string, path: string, label: string): string {
  return `<a href="${escapeHtml(new URL(path, origin).toString())}">${escapeHtml(label)}</a>`;
}

/** Коли й куди йдуть вакансії людини: «every day at 07:00 (Europe/Paris), in this chat». */
export type Schedule = { hour: number; timezone: string | null; channel: Channel; hasEmail: boolean };

function when(s: Schedule): string {
  const tz = (s.timezone || "UTC").replace(/_/g, " ");
  // Як planChannel в engine: канал людини, а якщо ним нема чим слати, другий, що є.
  const where = s.channel === "email" && s.hasEmail ? "by email" : "in this chat";
  return `every day at ${hourLabel(s.hour)} (${tz}), ${where}`;
}

const HOW_IT_WORKS =
  "1. On the site you tell us, in your own words, what job you want, then pick your roles, remote or a city, and your minimum pay.\n" +
  "2. Every day at the hour you choose we check every live crypto job we have and send you the 5 that fit you best, here or by email.\n" +
  "3. Each job says why it fits you and links straight to the application.";

const COMMANDS =
  "/jobs: the last jobs we sent you\n/stop: pause daily jobs\n/start: turn them back on\n/help: how it works and these commands";

export const BOT_TEXT = {
  startKnown: (origin: string, s: Schedule) =>
    `Welcome back to NextCryptoJob.\n\nYour jobs come ${when(s)}: up to 5 that fit your brief best, each with the reasons why.\n\n` +
    `/jobs shows the jobs we already sent you.\n` +
    `Want different jobs? Change what you are looking for in ${named(origin, "/welcome?step=target", "your brief")}. ` +
    `Change the hour or the channel in ${named(origin, "/settings", "Settings")}.`,
  startResumed: (origin: string, s: Schedule) =>
    `Daily jobs are back on. They come ${when(s)}.\n\n/jobs shows the jobs we already sent you.\n` +
    `Change the hour or the channel in ${named(origin, "/settings", "Settings")}.`,
  startNew: (origin: string) =>
    `Hi! I am the NextCryptoJob bot. I send you crypto jobs that fit you, every day.\n\n<b>How it works</b>\n${HOW_IT_WORKS}\n\n` +
    `Start on the site: ${link(origin, "/login")}\nSign in with this Telegram and your daily jobs come to this chat.\n\n/help lists the commands.`,
  help: (origin: string, s: Schedule | null) =>
    `<b>How it works</b>\n${HOW_IT_WORKS}\n` +
    (s ? `\nYour jobs come ${when(s)}.\n` : `\nThis Telegram is not connected yet. Sign in on the site with it: ${link(origin, "/login")}\n`) +
    `\n<b>Commands</b>\n${COMMANDS}\n\n<b>On the site</b>\n` +
    `${named(origin, "/jobs", "Your jobs")}: today's best matches and everything we sent, with the reasons\n` +
    `${named(origin, "/welcome?step=target", "Your brief")}: change what you are looking for\n` +
    `${named(origin, "/settings", "Settings")}: the hour, the channel, pause`,
  stopNotLinked: () => "This Telegram is not connected to a NextCryptoJob profile, so there is nothing to stop.",
  stopDone: (origin: string) =>
    `Daily jobs are paused. We keep your brief and the jobs we sent you (/jobs).\n\n` +
    `Send /start to resume, or change it in ${named(origin, "/settings", "Settings")}.`,
  jobsNotLinked: (origin: string) =>
    `This Telegram is not connected to a NextCryptoJob profile yet. Sign in on the site with it: ${link(origin, "/login")}\n` +
    "Then your daily jobs come to this chat, and /jobs shows them.",
  jobsNone: (origin: string, s: Schedule, paused: boolean) =>
    `We have not sent you any jobs yet. ${paused ? "Daily jobs are paused: send /start to turn them on." : `Your first ones come ${when(s)}.`}\n\n` +
    `See the jobs that fit you right now: ${named(origin, "/jobs", "your jobs page")}.`,
  jobsUnavailable: (origin: string) =>
    `We could not load your jobs right now. Try again in a minute, or open ${named(origin, "/jobs", "your jobs page")}.`,
  unknown: () => "I understand /start, /jobs, /help and /stop.",
  unknownAction: "Unknown action",
  introFailed: "Something went wrong. Try again from the link in the message.",
} as const;

/**
 * Список /jobs: вакансії по днях, новіші зверху. Посилання вакансії рівно та адреса, що в базі
 * (web3.career забороняє міняти apply_url), і web3.career названо джерелом; вакансія компанії
 * веде на її сторінку на сайті. Лише http(s) стає посиланням: інше Bot API відкинув би з усім повідомленням.
 */
export function jobsList(origin: string, jobs: readonly RecentJob[]): string {
  const blocks: string[] = [];
  let day: string | null = null;
  jobs.forEach((j, i) => {
    const lines: string[] = [];
    if (j.localDate !== day) {
      day = j.localDate;
      lines.push(`<b>${escapeHtml(shortDate(j.localDate))}</b>`);
    }
    const d = j.details;
    if (!d) {
      lines.push(`${i + 1}. ${j.state === "unavailable" ? "Details are not available right now." : "This job is no longer listed."}`);
    } else {
      const title = escapeHtml(cleanText(d.title, 120));
      // Вакансія компанії: її сторінка на нашому сайті; решта рівно адреса з бази.
      const href = d.url?.startsWith("/") ? `${origin}${d.url}` : d.url;
      lines.push(href && /^https?:\/\//i.test(href) ? `${i + 1}. <a href="${escapeHtml(href)}">${title}</a>` : `${i + 1}. ${title}`);
      const meta = [cleanText(d.company, 60), d.location ? cleanText(d.location, 60) : null, d.salary].filter(Boolean).join(" · ");
      if (meta) lines.push(escapeHtml(meta));
      const via = d.postedBy ? null : jobVia(d.url);
      if (via) lines.push(`via ${via}`);
    }
    blocks.push(lines.join("\n"));
  });
  const n = jobs.length;
  return `<b>The last ${n === 1 ? "job" : `${n} jobs`} we sent you</b>\n\n${blocks.join("\n\n")}\n\n` +
    `Every job with the reasons it fits: ${named(origin, "/jobs", "your jobs page")}.`;
}

/** Команда з тексту: "/start", "/Start@nextcryptojob_bot payload" → "start". */
export function parseCommand(text: string | undefined): string | null {
  const m = /^\/([A-Za-z0-9_]{1,32})(?:@[A-Za-z0-9_]+)?(?:\s|$)/.exec(text?.trim() ?? "");
  return m ? m[1].toLowerCase() : null;
}

type Profile = { id: string; channel: Channel; digest_paused: number; digest_hour: number; timezone: string | null; email: string | null };

async function profileByTelegram(telegramId: number): Promise<Profile | null> {
  return db()
    .prepare("SELECT id, channel, digest_paused, digest_hour, timezone, email FROM users WHERE telegram_id = ?")
    .bind(String(telegramId))
    .first<Profile>();
}

const scheduleOf = (u: Profile): Schedule => ({ hour: u.digest_hour, timezone: u.timezone, channel: u.channel, hasEmail: !!u.email });

/**
 * Пауза щоденних вакансій (users.digest_paused), той самий прапор, що в /settings.
 * Канал не чіпаємо: після /start вакансії підуть туди ж, куди йшли. true, якщо
 * прапор справді змінився (тоді й запис у журнал).
 */
async function setPaused(userId: string, paused: boolean): Promise<boolean> {
  const res = await db()
    .prepare("UPDATE users SET digest_paused = ?2 WHERE id = ?1 AND digest_paused <> ?2")
    .bind(userId, paused ? 1 : 0)
    .run();
  return res.meta.changes === 1;
}

/** /stop завжди зупиняє розсилку, хоч би куди вона йшла: пошта чи цей чат. */
async function stop(from: TgUser, origin: string): Promise<string> {
  const user = await profileByTelegram(from.id);
  if (!user) return BOT_TEXT.stopNotLinked();
  if (await setPaused(user.id, true)) await audit(user.id, "bot.stop", user.id, { digest_paused: true });
  return BOT_TEXT.stopDone(origin);
}

/** /start: незнайомцю привітання, своєму знімає паузу, якщо вона була. */
async function start(from: TgUser, origin: string): Promise<string> {
  const user = await profileByTelegram(from.id);
  if (!user) return BOT_TEXT.startNew(origin);
  if (user.digest_paused !== 1) return BOT_TEXT.startKnown(origin, scheduleOf(user));
  if (await setPaused(user.id, false)) await audit(user.id, "bot.start", user.id, { digest_paused: false });
  return BOT_TEXT.startResumed(origin, scheduleOf(user));
}

async function help(from: TgUser, origin: string): Promise<string> {
  const user = await profileByTelegram(from.id);
  return BOT_TEXT.help(origin, user ? scheduleOf(user) : null);
}

/** /jobs: останні надіслані саме цій людині (за її telegram_id), з посиланнями. */
async function jobs(from: TgUser, ctx: BotContext): Promise<string> {
  const user = await profileByTelegram(from.id);
  if (!user) return BOT_TEXT.jobsNotLinked(ctx.origin);
  const list = await recentSentJobs(db(), (ctx.jobs ?? jobsDb)(), user.id, BOT_JOBS_LIMIT);
  if (list === null) return BOT_TEXT.jobsUnavailable(ctx.origin);
  if (list.length === 0) return BOT_TEXT.jobsNone(ctx.origin, scheduleOf(user), user.digest_paused === 1);
  return jobsList(ctx.origin, list);
}

export async function handleMessage(message: TgMessage, ctx: BotContext): Promise<void> {
  if (message.chat?.type !== "private" || !message.from || message.from.is_bot) return;
  const from = message.from;

  let reply: string;
  switch (parseCommand(message.text)) {
    case "start":
      reply = await start(from, ctx.origin);
      break;
    case "help":
      reply = await help(from, ctx.origin);
      break;
    case "jobs":
      reply = await jobs(from, ctx);
      break;
    case "stop":
      reply = await stop(from, ctx.origin);
      break;
    default:
      reply = BOT_TEXT.unknown();
  }
  await sendMessage(ctx.token, message.chat.id, reply, {}, ctx.deps);
}

/**
 * Натискання кнопок під повідомленнями бота. Диспетчер за префіксом
 * callback_data ("<дія>:<аргументи>").
 *
 * Кожна гілка мусить сама відповісти answerCallbackQuery.
 * - `ia:` / `id:` / `ib:<intro_id>`: відповідь на запит знайомства (CRM 5.5):
 *   Accept, Decline, Decline and block (lib/crm/intro-callbacks.ts). Бот
 *   відповідає на натискання й пише результат у чат.
 * Решта кнопок отримує «Unknown action».
 */
export async function handleCallbackQuery(query: TgCallbackQuery, ctx: BotContext): Promise<void> {
  const action = (query.data ?? "").split(":", 1)[0];
  switch (action) {
    case "ia":
    case "id":
    case "ib": {
      // Кнопку треба відповісти завжди, інакше Telegram крутить годинник на ній.
      let r: { answer: string; reply: string | null };
      try {
        r = await handleIntroCallback(query, ctx);
      } catch (err) {
        console.error(`telegram intro button failed: ${err instanceof Error ? err.message : String(err)}`);
        r = { answer: BOT_TEXT.introFailed, reply: null };
      }
      await answerCallbackQuery(ctx.token, query.id, r.answer, ctx.deps);
      if (r.reply) await sendMessage(ctx.token, query.from.id, r.reply, {}, ctx.deps);
      break;
    }
    default:
      await answerCallbackQuery(ctx.token, query.id, BOT_TEXT.unknownAction, ctx.deps);
  }
}

export async function handleUpdate(update: TgUpdate, ctx: BotContext): Promise<void> {
  if (update.callback_query) return handleCallbackQuery(update.callback_query, ctx);
  if (update.message) return handleMessage(update.message, ctx);
}
