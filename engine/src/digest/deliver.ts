// Доставка добірки: Telegram (Bot API sendMessage) або лист через внутрішній ендпойнт сайту.
// Контракт ендпойнта листа: engine/src/digest/README.md.
//
// Токени й секрети в журнал не йдуть ніколи: адреса Bot API містить токен у шляху,
// тож з помилок fetch пишемо лише тип.
import { createHmac } from "node:crypto";
import { limiterFor } from "../limits.js";
import type { EngineEnv } from "../pipeline/registry.js";

export const DEFAULT_SITE_URL = "https://nextcryptojob.xyz";
export const SIGNATURE_HEADER = "NCJ-Internal-Signature";
export const EMAIL_PATH = "/api/internal/digest-email";
export const EMAIL_NOT_CONFIGURED = "email not configured";
export const TELEGRAM_NOT_CONFIGURED = "telegram not configured: TELEGRAM_BOT_TOKEN";

const TELEGRAM_HOST = "api.telegram.org";
/** Скільки разів пробувати sendMessage, якщо Telegram каже 429. Інші відмови не повторюємо: лист міг піти. */
const TELEGRAM_ATTEMPTS = 3;
/** Стеля очікування retry_after: довше не тримаємо прогін, добірка стане failed. */
const MAX_RETRY_AFTER_MS = 60_000;
const CALL_TIMEOUT_MS = 15_000;
/** Ліміт Telegram на повідомлення: 4096 символів. */
const TELEGRAM_MAX_CHARS = 4096;

export interface DeliveryJob {
  position: number;
  title: string;
  company: string;
  location: string | null;
  salary: string | null;
  why: string;
  url: string;
  /** Для вакансій компаній: «Posted by {Company} on NextCryptoJob». */
  postedBy: string | null;
  source: "nextrole" | "company";
}

export interface DigestMessage {
  digestId: string;
  userId: string;
  /** Дата людини, YYYY-MM-DD. */
  localDate: string;
  jobs: DeliveryJob[];
}

export interface DeliveryUser {
  id: string;
  channel: string;
  email: string | null;
  telegramId: string | null;
}

export type Channel = "telegram" | "email";

export type DeliveryOutcome =
  | { status: "sent"; channel: Channel; note: string | null }
  | { status: "failed"; channel: Channel | null; error: string };

export interface DeliverDeps {
  env: EngineEnv;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  log?: (line: string) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Адреса сайту без кінцевого «/»; лише https (http лише для localhost у розробці). null, якщо не задано чи криво. */
export function siteUrlOf(env: EngineEnv): string | null {
  const raw = env.SITE_URL?.trim();
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

// ---------------- канал ----------------

export type ChannelPlan =
  | { primary: Channel; emailFallback: boolean }
  | { skip: string };

/**
 * Куди слати, ще до підбору. Канал людини, а якщо його нема чим обслужити, другий,
 * що в неї є. Telegram без токена бота: людину пропускаємо (нічого не пишемо в базу,
 * вакансії не згорають), доки токен не з'явиться; так само робить NextRole.
 */
export function planChannel(user: DeliveryUser, env: EngineEnv): ChannelPlan {
  const hasTg = !!user.telegramId;
  const hasEmail = !!user.email;
  const token = !!env.TELEGRAM_BOT_TOKEN;
  if (user.channel === "telegram" && hasTg) {
    return token ? { primary: "telegram", emailFallback: hasEmail } : { skip: TELEGRAM_NOT_CONFIGURED };
  }
  if (hasEmail) return { primary: "email", emailFallback: false };
  if (hasTg) return token ? { primary: "telegram", emailFallback: false } : { skip: TELEGRAM_NOT_CONFIGURED };
  return { skip: "no delivery channel (no email, no Telegram)" };
}

// ---------------- текст ----------------

/** Екранування для parse_mode HTML. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Дані з джерел: без довгого тире (договір), без зайвих пробілів, не довше max. */
export function cleanText(text: string, max = 140): string {
  const t = text.replace(/&amp;/g, "&").replace(/\u2014/g, "-").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t;
}

/** «Sep 12» з YYYY-MM-DD. */
export function shortDate(localDate: string): string {
  const d = new Date(`${localDate}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? localDate : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function telegramText(m: DigestMessage, siteUrl: string): string {
  const head = `<b>Your crypto jobs for ${escapeHtml(shortDate(m.localDate))}</b>`;
  const blocks = m.jobs.map((j) => {
    const meta = [cleanText(j.company, 60), j.location ? cleanText(j.location, 60) : null, j.salary].filter(Boolean).join(" · ");
    const lines = [
      `${j.position}. <a href="${escapeHtml(j.url)}"><b>${escapeHtml(cleanText(j.title))}</b></a>`,
      escapeHtml(meta),
      `<i>${escapeHtml(j.why)}</i>`,
    ];
    if (j.postedBy) lines.push(`Posted by ${escapeHtml(cleanText(j.postedBy, 60))} on NextCryptoJob`);
    return lines.join("\n");
  });
  const foot = `Change the time or pause the digest: <a href="${escapeHtml(siteUrl)}/account">your account</a>.`;
  let text = [head, ...blocks, foot].join("\n\n");
  // П'ять вакансій у 4096 символів вміщаються з запасом; обрізаємо лише на випадок дивних даних.
  while (text.length > TELEGRAM_MAX_CHARS && blocks.length > 1) {
    blocks.pop();
    text = [head, ...blocks, foot].join("\n\n");
  }
  return text;
}

// ---------------- Telegram ----------------

type TgBody = { ok: boolean; description?: string; error_code?: number; parameters?: { retry_after?: number } };

export type TelegramResult =
  | { ok: true }
  | { ok: false; status: number | null; description: string; unreachable: boolean };

/**
 * Людина недосяжна через бота: заблокувала його (403), видалила акаунт або ніколи
 * не натискала Start (400 chat not found). Тоді є сенс у листі.
 */
function isUnreachable(status: number, description: string): boolean {
  if (status === 403) return true;
  return status === 400 && /chat not found|user not found|peer_id_invalid/i.test(description);
}

export async function sendTelegram(token: string, chatId: string, text: string, deps: DeliverDeps): Promise<TelegramResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const url = `https://${TELEGRAM_HOST}/bot${token}/sendMessage`;
  const payload = JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  for (let attempt = 1; attempt <= TELEGRAM_ATTEMPTS; attempt++) {
    let status: number;
    let body: TgBody;
    try {
      ({ status, body } = await limiterFor(TELEGRAM_HOST).run(async () => {
        const res = await fetchImpl(url, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: payload,
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
        let b: TgBody = { ok: false, description: `HTTP ${res.status}` };
        try { b = (await res.json()) as TgBody; } catch { /* тіло не JSON: лишаємо статус */ }
        return { status: res.status, body: b };
      }));
    } catch (e) {
      // Адреса з токеном може бути в тексті помилки: лише тип.
      return { ok: false, status: null, description: `network error (${e instanceof Error ? e.name : "unknown"})`, unreachable: false };
    }
    if (body.ok && status >= 200 && status < 300) return { ok: true };
    const description = (body.description ?? `HTTP ${status}`).slice(0, 200);
    if (status === 429 && attempt < TELEGRAM_ATTEMPTS) {
      const s = body.parameters?.retry_after;
      const wait = typeof s === "number" && s > 0 ? s * 1000 : 1000;
      if (wait > MAX_RETRY_AFTER_MS) return { ok: false, status, description: `${description} (retry_after ${s}s too long)`, unreachable: false };
      // Людей обслуговуємо по одному, тож пауза тут тримає і всіх наступних.
      await sleep(wait);
      continue;
    }
    return { ok: false, status, description, unreachable: isUnreachable(status, description) };
  }
  return { ok: false, status: 429, description: "Too Many Requests after retries", unreachable: false };
}

// ---------------- лист ----------------

export interface EmailPayload {
  version: 1;
  digest_id: string;
  user_id: string;
  local_date: string;
  /** Unix-секунди підпису: сайт відкидає запити старші за 5 хвилин. */
  ts: number;
  jobs: Array<{
    position: number; title: string; company: string; location: string | null; salary: string | null;
    why: string; url: string; posted_by: string | null; source: "nextrole" | "company";
  }>;
}

export function emailPayload(m: DigestMessage, now: Date): EmailPayload {
  return {
    version: 1, digest_id: m.digestId, user_id: m.userId, local_date: m.localDate, ts: Math.floor(now.getTime() / 1000),
    jobs: m.jobs.map((j) => ({
      position: j.position, title: cleanText(j.title, 200), company: cleanText(j.company, 100),
      location: j.location ? cleanText(j.location, 100) : null, salary: j.salary, why: j.why, url: j.url,
      posted_by: j.postedBy, source: j.source,
    })),
  };
}

/** Значення заголовка підпису: `sha256=<hex HMAC-SHA256(INTERNAL_API_SECRET, сире тіло)>`. */
export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

export type EmailResult = { ok: true } | { ok: false; error: string };

/**
 * POST на сайт. 2xx і 409 (цей digest_id уже відправлено) = доставлено. 503 = пошта на
 * сайті ще не налаштована. Мережевий збій повторюємо один раз: сайт відкидає дубль за digest_id.
 */
export async function sendEmail(m: DigestMessage, deps: DeliverDeps): Promise<EmailResult> {
  const site = siteUrlOf(deps.env);
  const secret = deps.env.INTERNAL_API_SECRET;
  if (!site || !secret) return { ok: false, error: EMAIL_NOT_CONFIGURED };
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const body = JSON.stringify(emailPayload(m, (deps.now ?? (() => new Date()))()));
  const url = `${site}${EMAIL_PATH}`;
  const host = new URL(url).host;
  let last = "email endpoint unreachable";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const status = await limiterFor(host).run(async () => {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", [SIGNATURE_HEADER]: signBody(secret, body) },
          body, redirect: "manual", signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
        await res.body?.cancel().catch(() => undefined);
        return res.status;
      });
      if ((status >= 200 && status < 300) || status === 409) return { ok: true };
      if (status === 503) return { ok: false, error: EMAIL_NOT_CONFIGURED };
      if (status < 500) return { ok: false, error: `email endpoint HTTP ${status}` };
      last = `email endpoint HTTP ${status}`;
    } catch (e) {
      last = `email endpoint unreachable (${e instanceof Error ? e.name : "unknown"})`;
    }
    if (attempt < 2) await sleep(2_000);
  }
  return { ok: false, error: last };
}

// ---------------- разом ----------------

/**
 * Доставити одну добірку. Telegram, якщо це канал людини; бот заблоковано або чат не
 * знайдено → лист, якщо є пошта. Повертає підсумок для sent і digest_runs.
 */
export async function deliverDigest(user: DeliveryUser, m: DigestMessage, plan: { primary: Channel; emailFallback: boolean }, deps: DeliverDeps): Promise<DeliveryOutcome> {
  if (plan.primary === "email") {
    const r = await sendEmail(m, deps);
    return r.ok ? { status: "sent", channel: "email", note: null } : { status: "failed", channel: "email", error: r.error };
  }
  const token = deps.env.TELEGRAM_BOT_TOKEN;
  if (!token || !user.telegramId) return { status: "failed", channel: "telegram", error: TELEGRAM_NOT_CONFIGURED };
  const site = siteUrlOf(deps.env) ?? DEFAULT_SITE_URL;
  const tg = await sendTelegram(token, user.telegramId, telegramText(m, site), deps);
  if (tg.ok) return { status: "sent", channel: "telegram", note: null };
  const tgError = `telegram ${tg.status ?? "error"}: ${tg.description}`;
  if (!tg.unreachable || !plan.emailFallback) return { status: "failed", channel: "telegram", error: tgError };
  const r = await sendEmail(m, deps);
  return r.ok
    ? { status: "sent", channel: "email", note: `${tgError}; sent by email instead` }
    : { status: "failed", channel: "email", error: `${tgError}; email fallback: ${r.error}` };
}
