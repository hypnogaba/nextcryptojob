import { getMailer, type Mailer, type MailMessage } from "@/lib/mail";
import { escapeHtml, sendMessage, type SendDeps } from "@/lib/telegram/send";
import { fromSqlTime } from "@/lib/time";
import { aboutRoleText } from "./labels";
import { candidateLabel } from "./project";

/**
 * Листи й повідомлення бота про знайомства (специфікація CRM, 5.5 і 11).
 *
 * Кандидату: запит у його канал (users.channel) з кнопками Telegram
 * `ia:<id>` (Accept), `id:<id>` (Decline), `ib:<id>` (Decline and block this company);
 * не дійшло (бот заблоковано, пошти немає, пошта ще не підключена), тоді
 * другий канал, якщо він є. Не дійшло нікуди: викликач пише intros.notify_error,
 * а компанія бачить NOT_REACHED_TEXT.
 * Компанії (тому, хто просив; агентові: власникам): «так» і прострочення.
 * Контакт кандидата в тексті для компанії не пишемо НІКОЛИ: лише мітку #3F9A1C
 * і посилання на воронку.
 *
 * Тексти англійською, без довгого тире. Текст людини (повідомлення компанії,
 * назва компанії, "Hiring for") у Telegram екрануємо, бо parse_mode HTML.
 */

export const FALLBACK_ORIGIN = "https://nextcryptojob.xyz";

/** Те, що компанія бачить, коли кандидата не вдалося сповістити (candidate_notified = false). */
export const NOT_REACHED_TEXT = "We could not reach the candidate yet.";

/** Змінні оточення для сповіщень. Відсутні = undefined. */
export interface NotifyEnv {
  TELEGRAM_BOT_TOKEN?: string;
  EMAIL?: SendEmail;
  SITE_URL?: string;
}

/** Чим і куди слати: бот, пошта (null = нічим), адреса сайту для посилань. */
export interface Notifier {
  botToken?: string;
  mailer: Mailer | null;
  /** Походження сайту, напр. https://nextcryptojob.xyz. */
  origin: string;
  /** Для тестів: свій fetch для Bot API. */
  send?: SendDeps;
}

/** Адреса сайту: SITE_URL з оточення Worker або процесу, інакше nextcryptojob.xyz. */
export function siteOrigin(env: { SITE_URL?: string } = {}): string {
  for (const raw of [env.SITE_URL, process.env.SITE_URL]) {
    const value = raw?.trim();
    if (!value) continue;
    try {
      return new URL(value).origin;
    } catch {
      // Хибна адреса в налаштуваннях: беремо наступну.
    }
  }
  return FALLBACK_ORIGIN;
}

export function notifierFromEnv(env: NotifyEnv, overrides: Partial<Notifier> = {}): Notifier {
  return {
    botToken: env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
    mailer: getMailer(env),
    origin: siteOrigin(env),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Доставка

export interface Recipient {
  channel: "email" | "telegram";
  telegramId: string | null;
  email: string | null;
}

export interface OutgoingMessage {
  /** Текст з розміткою HTML (уже екранований). */
  telegramHtml: string;
  replyMarkup?: Record<string, unknown>;
  email: Omit<MailMessage, "to">;
}

export type Delivery = { ok: true; channel: "telegram" | "email" } | { ok: false; error: string };

/** Пошта в тексті помилки не потрапляє в базу: помилку читає адмін, а не власник адреси. */
function scrub(text: string): string {
  return text.replace(/\S+@\S+/g, "[email]").slice(0, 200);
}

/**
 * Спершу канал людини, потім другий, якщо він є. Помилки обох каналів разом
 * (для intros.notify_error), без адрес і токенів.
 */
export async function deliver(to: Recipient, message: OutgoingMessage, n: Notifier): Promise<Delivery> {
  const order: ("telegram" | "email")[] = to.channel === "telegram" ? ["telegram", "email"] : ["email", "telegram"];
  const errors: string[] = [];
  for (const channel of order) {
    if (channel === "telegram") {
      if (!to.telegramId) continue;
      if (!n.botToken) {
        errors.push("telegram: not configured: TELEGRAM_BOT_TOKEN");
        continue;
      }
      const extra = message.replyMarkup ? { reply_markup: message.replyMarkup } : {};
      const res = await sendMessage(n.botToken, to.telegramId, message.telegramHtml, extra, n.send);
      if (res.ok) return { ok: true, channel };
      errors.push(`telegram: ${scrub(res.description ?? "failed")}`);
    } else {
      if (!to.email) continue;
      if (!n.mailer) {
        errors.push("email: not configured: EMAIL");
        continue;
      }
      try {
        await n.mailer.send({ to: to.email, ...message.email });
        return { ok: true, channel };
      } catch (error) {
        errors.push(`email: ${scrub(error instanceof Error ? error.message || error.name : "failed")}`);
      }
    }
  }
  return { ok: false, error: errors.length ? errors.join("; ") : "no channel: neither Telegram nor email" };
}

// ---------------------------------------------------------------------------
// Тексти

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** "Sep 26, 2026" з часу SQLite (UTC). */
export function introDate(sql: string): string {
  return DATE.format(fromSqlTime(sql));
}

/** Назва компанії для теми листа й кнопок: один рядок. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** "about an Engineer role" / "about a role" (той самий текст показує попередній перегляд у діалозі CRM). */
const aboutRole = aboutRoleText;

export interface IntroRequestDetails {
  introId: string;
  companyName: string;
  domain: string | null;
  domainVerified: boolean;
  role: string | null;
  message: string;
  hiringFor: string | null;
  jobId: string | null;
  jobTitle: string | null;
  /** Час SQLite (UTC). */
  expiresAt: string;
}

interface Line {
  text: string;
  /** Посилання в Telegram і HTML листа: [підпис, адреса]. */
  link?: { label: string; href: string };
}

/** Рядки запиту за шаблоном 5.5 (однакові для Telegram, листа і сторінки /intro/[id]). */
export function introRequestLines(d: IntroRequestDetails, origin: string): Line[] {
  const company = oneLine(d.companyName);
  const lines: Line[] = [{ text: `${company} wants to talk to you ${aboutRole(d.role)}.` }, { text: "" }];
  lines.push({ text: `"${d.message.trim()}"` }, { text: "" });
  if (d.hiringFor) lines.push({ text: `Hiring for: ${oneLine(d.hiringFor)}` });
  if (d.jobId) {
    const url = new URL(`/jobs/${d.jobId}`, origin);
    const shown = `${url.host}${url.pathname}`;
    lines.push({ text: `Job: ${oneLine(d.jobTitle ?? "Open job")} (${shown})`, link: { label: shown, href: url.toString() } });
  }
  if (d.domain) lines.push({ text: `Company site: ${d.domain}${d.domainVerified ? " (domain verified)" : ""}` });
  lines.push({ text: `This request expires on ${introDate(d.expiresAt)}.` });
  return lines;
}

function htmlLine(line: Line): string {
  if (!line.link) return escapeHtml(line.text);
  // Адреса стоїть у кінці рядка; назва вакансії перед нею могла б її повторити.
  const at = line.text.lastIndexOf(line.link.label);
  const before = line.text.slice(0, at);
  const after = line.text.slice(at + line.link.label.length);
  return `${escapeHtml(before)}<a href="${escapeHtml(line.link.href)}">${escapeHtml(line.link.label)}</a>${escapeHtml(after)}`;
}

/** Кнопки під запитом у Telegram (callback_data до 64 байтів: "ia:int_" + 20). */
export function introButtons(introId: string): Record<string, unknown> {
  return {
    inline_keyboard: [
      [
        { text: "Accept", callback_data: `ia:${introId}` },
        { text: "Decline", callback_data: `id:${introId}` },
      ],
      [{ text: "Decline and block this company", callback_data: `ib:${introId}` }],
    ],
  };
}

export function introReviewUrl(origin: string, introId: string, token: string): string {
  const url = new URL(`/intro/${introId}`, origin);
  url.searchParams.set("t", token);
  return url.toString();
}

/** Що побачить компанія після «так»: Telegram-нік, або пошта (маскована для показу), або нічого. */
export type ContactPreview = { kind: "telegram" | "email"; shown: string } | null;

/** Рядок «що буде відкрито» (запит у Telegram і листі, сторінка /intro/[id]). */
export function contactPreviewText(companyName: string, contact: ContactPreview): string {
  const company = oneLine(companyName);
  if (contact?.kind === "telegram") {
    return `If you accept, ${company} will see your Telegram handle ${contact.shown}. They will not see your email or wallets.`;
  }
  if (contact?.kind === "email") {
    return `If you accept, ${company} will see your email address ${contact.shown}. They will not see your wallets.`;
  }
  return ANSWER_TEXT.noContact;
}

/**
 * Запит кандидату: Telegram з кнопками і лист з посиланням на /intro/{id}?t={token}.
 * Наприкінці рядок про контакт, щоб людина знала, що саме відкриє «Accept».
 */
export function introRequestMessage(
  d: IntroRequestDetails,
  origin: string,
  token: string | null,
  contact: ContactPreview,
): OutgoingMessage {
  const lines = [...introRequestLines(d, origin), { text: "" }, { text: contactPreviewText(d.companyName, contact) }];
  const company = oneLine(d.companyName);
  const review = token ? introReviewUrl(origin, d.introId, token) : new URL(`/intro/${d.introId}`, origin).toString();
  const text = `${lines.map((l) => l.text).join("\n")}\n\nReview the request: ${review}\n`;
  const html =
    lines.map((l) => (l.text ? `<p>${htmlLine(l)}</p>` : "")).join("") +
    `<p><a href="${escapeHtml(review)}" style="display:inline-block;padding:10px 16px;border-radius:8px;` +
    `background:#111;color:#fff;text-decoration:none;font-weight:600">Review the request</a></p>`;
  return {
    telegramHtml: lines.map(htmlLine).join("\n"),
    replyMarkup: introButtons(d.introId),
    email: { subject: `${company} wants to talk to you`, text, html },
  };
}

/** Режим direct: прозорість для кандидата, без кнопок. */
export function directRevealMessage(companyName: string): OutgoingMessage {
  const text = `${oneLine(companyName)} viewed your Telegram handle.`;
  return {
    telegramHtml: escapeHtml(text),
    email: { subject: text.slice(0, -1), text: `${text}\n`, html: `<p>${escapeHtml(text)}</p>` },
  };
}

function companyMessage(text: string, subject: string, origin: string): OutgoingMessage {
  const url = new URL("/company/pipeline", origin).toString();
  return {
    telegramHtml: `${escapeHtml(text)}\n\n<a href="${escapeHtml(url)}">Open the pipeline</a>`,
    email: {
      subject,
      text: `${text}\n\nOpen the pipeline: ${url}\n`,
      html: `<p>${escapeHtml(text)}</p><p><a href="${escapeHtml(url)}">Open the pipeline</a></p>`,
    },
  };
}

/** «Так» кандидата для компанії. Контакту тут немає: лише мітка й воронка. */
export function introAcceptedMessage(candidateId: string, origin: string): OutgoingMessage {
  const label = candidateLabel(candidateId);
  return companyMessage(
    `Candidate ${label} accepted your intro request. Open the pipeline to see the contact.`,
    `Candidate ${label} accepted your intro request`,
    origin,
  );
}

/** Прострочення для компанії. */
export function introExpiredMessage(candidateId: string, origin: string): OutgoingMessage {
  const label = candidateLabel(candidateId);
  return companyMessage(`No answer from ${label} in 14 days.`, `No answer from ${label}`, origin);
}

/**
 * Плашка для компанії біля знайомства (воронка, профіль): кандидата ще не
 * вдалося сповістити. null, коли сказати нічого.
 */
export function companyIntroNotice(intro: { status: string; candidate_notified?: boolean }): string | null {
  return intro.status === "pending" && intro.candidate_notified === false ? NOT_REACHED_TEXT : null;
}

/** Відповіді кандидату (бот і сторінка /intro/[id]). Простий текст: викликач екранує для HTML. */
export const ANSWER_TEXT = {
  accepted: (company: string, kind: "telegram" | "email") =>
    `Done. ${oneLine(company)} can now see your ${kind === "telegram" ? "Telegram handle" : "email address"}.`,
  declined: (company: string) => `Declined. ${oneLine(company)} will not contact you.`,
  blocked: (company: string) => `Declined. ${oneLine(company)} will not contact you again.`,
  alreadyAnswered: "You already answered this request.",
  expired: "This request has expired.",
  withdrawn: "This request was withdrawn.",
  noContact: "Add a Telegram username or an email to your account first, then accept.",
  notYours: "This request is for another account.",
  companyInactive: "This company can no longer receive contacts.",
  invalid: "This link is not valid or has already been used.",
} as const;
