import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { setChannel } from "./channel";
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

export const BOT_TEXT = {
  startKnown: (origin: string) =>
    `Welcome back to NextCryptoJob.\n\nYour score, profile and daily jobs live on the site: ${link(origin, "/account")}\n\n/help lists what I can do here.`,
  startNew: (origin: string) =>
    `Hi! NextCryptoJob turns your public crypto work into a score and sends you jobs that fit it.\n\n` +
    `Create your profile on the site: ${link(origin, "/login")}\n` +
    `Then connect this Telegram in your account to get daily jobs here.\n\n/help lists what I can do here.`,
  help: (origin: string) =>
    `What I can do:\n/start: what NextCryptoJob is\n/help: this list\n/stop: stop daily jobs in Telegram\n\n` +
    `Your profile and settings live on the site: ${link(origin, "/account")}`,
  stopNotLinked: () => "This Telegram is not connected to a NextCryptoJob profile, so there is nothing to stop.",
  stopAlreadyEmail: () => "Daily jobs already go to your email, not here.",
  stopDone: (origin: string) =>
    `Done. Daily jobs will go to your email from now on.\n\nTo get them here again, switch Telegram back on in your account: ${link(origin, "/account")}`,
  stopNoEmail: (origin: string) =>
    `Your profile has no email, so daily jobs cannot move there.\n\nTo change how you get them, open your account on the site: ${link(origin, "/account")}`,
  unknown: () => "I understand /start, /help and /stop.",
  unknownAction: "Unknown action",
} as const;

/** Команда з тексту: "/start", "/Start@nextcryptojob_bot payload" → "start". */
export function parseCommand(text: string | undefined): string | null {
  const m = /^\/([A-Za-z0-9_]{1,32})(?:@[A-Za-z0-9_]+)?(?:\s|$)/.exec(text?.trim() ?? "");
  return m ? m[1].toLowerCase() : null;
}

async function profileByTelegram(telegramId: number) {
  return db()
    .prepare("SELECT id, channel FROM users WHERE telegram_id = ?")
    .bind(String(telegramId))
    .first<{ id: string; channel: "email" | "telegram" }>();
}

async function stop(from: TgUser, origin: string): Promise<string> {
  const user = await profileByTelegram(from.id);
  if (!user) return BOT_TEXT.stopNotLinked();
  if (user.channel === "email") return BOT_TEXT.stopAlreadyEmail();
  const result = await setChannel(db(), user.id, "email");
  switch (result) {
    case "changed":
      await audit(user.id, "bot.stop", user.id, { channel: "email" });
      return BOT_TEXT.stopDone(origin);
    case "unchanged":
      return BOT_TEXT.stopAlreadyEmail();
    case "no_email":
      return BOT_TEXT.stopNoEmail(origin);
    default:
      return BOT_TEXT.stopNotLinked();
  }
}

export async function handleMessage(message: TgMessage, ctx: BotContext): Promise<void> {
  if (message.chat?.type !== "private" || !message.from || message.from.is_bot) return;
  const from = message.from;

  let reply: string;
  switch (parseCommand(message.text)) {
    case "start":
      reply = (await profileByTelegram(from.id)) ? BOT_TEXT.startKnown(ctx.origin) : BOT_TEXT.startNew(ctx.origin);
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
 * CRM intros (наступна задача) додасть тут свої дії, наприклад
 * `case "intro":` для прийняти / відхилити знайомство. Кожна гілка мусить
 * сама відповісти answerCallbackQuery. Поки що дій немає: будь-яка кнопка
 * отримує «Unknown action».
 */
export async function handleCallbackQuery(query: TgCallbackQuery, ctx: BotContext): Promise<void> {
  const action = (query.data ?? "").split(":", 1)[0];
  switch (action) {
    default:
      await answerCallbackQuery(ctx.token, query.id, BOT_TEXT.unknownAction, ctx.deps);
  }
}

export async function handleUpdate(update: TgUpdate, ctx: BotContext): Promise<void> {
  if (update.callback_query) return handleCallbackQuery(update.callback_query, ctx);
  if (update.message) return handleMessage(update.message, ctx);
}
