import { appEnv, db as requestDb } from "@/lib/db";
import { getMailer, type Mailer } from "@/lib/mail";
import type { TgCallbackQuery } from "@/lib/telegram/bot";
import { callTelegram, escapeHtml, type SendDeps } from "@/lib/telegram/send";
import { answerText, candidateIntroRow, respondToIntro, type IntroDecision, type RespondOutcome } from "./intros";
import { ANSWER_TEXT } from "./notify";

/**
 * Кнопки під запитом на знайомство в Telegram (специфікація CRM, 5.5):
 * `ia:<intro_id>` Accept, `id:<intro_id>` Decline, `ib:<intro_id>` Decline and block.
 *
 * Хто натиснув, каже Telegram (callback_query.from.id): це має бути
 * users.telegram_id людини, якій адресоване знайомство. Токен не потрібен.
 * Відповідь та сама, що на сторінці /intro/[id]: одна транзакція, подвійне
 * натискання дає "You already answered this request.". Після остаточної
 * відповіді (і для простроченого чи відкликаного запиту) кнопки під
 * повідомленням зникають.
 *
 * bot.ts кличе це з handleCallbackQuery і сам відповідає Telegram:
 *   answerCallbackQuery(answer) і, якщо reply не null, sendMessage(reply).
 */

export const INTRO_CALLBACK_ACTIONS: Record<string, IntroDecision> = { ia: "accept", id: "decline", ib: "block" };

const DATA = /^(ia|id|ib):(int_[A-Za-z0-9]{20})$/;
/** Межа тексту answerCallbackQuery в Telegram. */
const ANSWER_MAX = 200;

export interface IntroCallbackEnv {
  /** TELEGRAM_BOT_TOKEN: прибрати кнопки й сповістити компанію. */
  token?: string;
  /** Походження сайту для посилань у повідомленнях компанії. */
  origin: string;
  deps?: SendDeps;
  /** Типово база й пошта поточного запиту Worker. */
  db?: D1Database;
  mailer?: Mailer | null;
  now?: Date;
}

export interface IntroCallbackResult {
  /** Текст для answerCallbackQuery (простий, до 200 символів). */
  answer: string;
  /** Повідомлення в чат (HTML, екрановано) або null. */
  reply: string | null;
}

/** Відповіді, після яких кнопки більше не потрібні. */
const FINAL: ReadonlySet<RespondOutcome["kind"]> = new Set(["accepted", "declined", "answered", "expired", "withdrawn"]);

function defaultMailer(): Mailer | null {
  try {
    return getMailer(appEnv());
  } catch {
    return null;
  }
}

export async function handleIntroCallback(query: TgCallbackQuery, env: IntroCallbackEnv): Promise<IntroCallbackResult> {
  const match = DATA.exec(query.data ?? "");
  if (!match) return { answer: "Unknown action", reply: null };
  const decision = INTRO_CALLBACK_ACTIONS[match[1]];
  const introId = match[2];
  const database = env.db ?? requestDb();

  const row = await candidateIntroRow(database, introId);
  if (!row) return { answer: ANSWER_TEXT.invalid, reply: null };
  // Кнопку міг натиснути лише той, кому бот надіслав запит; чужий акаунт нічого не змінює.
  if (!row.telegram_id || row.telegram_id !== String(query.from.id)) {
    return { answer: ANSWER_TEXT.notYours, reply: null };
  }

  const outcome = await respondToIntro(database, {
    introId,
    userId: row.user_id,
    decision,
    via: "telegram",
    now: env.now,
    notifier: {
      botToken: env.token,
      mailer: env.mailer !== undefined ? env.mailer : defaultMailer(),
      origin: env.origin,
      send: env.deps,
    },
  });
  const text = answerText(outcome);

  const message = query.message;
  if (FINAL.has(outcome.kind) && message && env.token) {
    await callTelegram(
      env.token,
      "editMessageReplyMarkup",
      { chat_id: message.chat.id, message_id: message.message_id, reply_markup: { inline_keyboard: [] } },
      env.deps,
    );
  }
  return {
    answer: text.length > ANSWER_MAX ? `${text.slice(0, ANSWER_MAX - 3)}...` : text,
    reply: escapeHtml(text),
  };
}
