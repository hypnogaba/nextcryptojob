import { audit } from "@/lib/audit";
import { handleIntroCallback } from "@/lib/crm/intro-callbacks";
import { db } from "@/lib/db";
import type { Channel } from "./channel";
import { answerCallbackQuery, escapeHtml, sendMessage, type SendDeps } from "./send";

/**
 * Мінімальний бот @nextcryptojob_bot: /start, /help, /stop і гачок для кнопок.
 * Лише приватні чати: у групі бот мовчить. Людина в приватному чаті має
 * chat.id = from.id, і це той самий id, що лежить у users.telegram_id після
 * входу через Telegram.
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
};

function link(origin: string, path: string): string {
  const url = new URL(path, origin);
  return `<a href="${escapeHtml(url.toString())}">${escapeHtml(url.host + url.pathname)}</a>`;
}

/** Посилання зі своїм словом замість адреси. */
function named(origin: string, path: string, label: string): string {
  return `<a href="${escapeHtml(new URL(path, origin).toString())}">${escapeHtml(label)}</a>`;
}

export const BOT_TEXT = {
  startKnown: (origin: string) =>
    `Welcome back to NextCryptoJob.\n\nYour score, profile and daily jobs live on the site: ${link(origin, "/account")}\n\n/help lists what I can do here.`,
  startResumed: (origin: string, channel: Channel) =>
    `Daily jobs are back on. ${channel === "telegram" ? "They come to this chat." : "They go to your email."}\n\n` +
    `Change the time or the channel in ${named(origin, "/settings", "Settings")}.`,
  startNew: (origin: string) =>
    `Hi! NextCryptoJob turns your public crypto work into a score and sends you jobs that fit it.\n\n` +
    `Create your profile on the site: ${link(origin, "/login")}\n` +
    `Then connect this Telegram in your account to get daily jobs here.\n\n/help lists what I can do here.`,
  help: (origin: string) =>
    `What I can do:\n/start: what NextCryptoJob is, or turn daily jobs back on\n/help: this list\n/stop: pause daily jobs\n\n` +
    `Your profile and settings live on the site: ${link(origin, "/account")}`,
  stopNotLinked: () => "This Telegram is not connected to a NextCryptoJob profile, so there is nothing to stop.",
  stopDone: (origin: string) =>
    `Daily jobs are paused. Send /start to resume, or change it in ${named(origin, "/settings", "Settings")}.`,
  unknown: () => "I understand /start, /help and /stop.",
  unknownAction: "Unknown action",
} as const;

/** Команда з тексту: "/start", "/Start@nextcryptojob_bot payload" → "start". */
export function parseCommand(text: string | undefined): string | null {
  const m = /^\/([A-Za-z0-9_]{1,32})(?:@[A-Za-z0-9_]+)?(?:\s|$)/.exec(text?.trim() ?? "");
  return m ? m[1].toLowerCase() : null;
}

type Profile = { id: string; channel: Channel; digest_paused: number };

async function profileByTelegram(telegramId: number): Promise<Profile | null> {
  return db()
    .prepare("SELECT id, channel, digest_paused FROM users WHERE telegram_id = ?")
    .bind(String(telegramId))
    .first<Profile>();
}

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
  if (user.digest_paused !== 1) return BOT_TEXT.startKnown(origin);
  if (await setPaused(user.id, false)) await audit(user.id, "bot.start", user.id, { digest_paused: false });
  return BOT_TEXT.startResumed(origin, user.channel);
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
      reply = BOT_TEXT.help(ctx.origin);
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
      const r = await handleIntroCallback(query, ctx);
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
