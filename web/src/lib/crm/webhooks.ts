import { hmacSha256Hex, hmacSha256Verify } from "@/lib/auth/hash";
import { isPublicHostname } from "@/lib/identity/normalize";
import { randomBase62 } from "@/lib/ids";
import { escapeHtml } from "@/lib/telegram/send";
import { isoTime, sqlTime } from "@/lib/time";
import type { HandlerResult } from "./actions";
import { auditActor } from "./audit";
import type { ActionContext, CompanyInfo } from "./context";
import { deliver, notifierFromEnv, siteOrigin, type Notifier, type NotifyEnv, type OutgoingMessage } from "./notify";
import { INTRO_COLUMNS, projectIntro, type IntroRow } from "./project";
import { ActionError, type Intro } from "./types";

/**
 * Вебхук компанії (специфікація CRM 7.6, openapi.yaml: getWebhook, setWebhook,
 * testWebhook і розділ webhooks).
 *
 * - Один URL на компанію (companies.webhook_url). Лише https на порту 443 і
 *   публічне доменне ім'я: без IP-літералів, localhost і локальних зон, без
 *   логіна й пароля в адресі, не наш власний домен (webhookUrlProblem).
 *   Перевірку DNS у Worker не робимо (вона дає хибні відмови): приватні адреси
 *   закриває прапор global_fetch_strictly_public у wrangler.jsonc, а fetch із
 *   Worker у будь-якому разі йде з мережі Cloudflare, не з нашої. Переходи
 *   (3xx) не виконуємо: redirect "manual", відповідь 3xx це невдача.
 * - Секрет не зберігаємо: `whsec_` + base64url(HMAC-SHA256(WEBHOOK_SIGNING_KEY,
 *   "{company_id}:{version}")). Показуємо при першому встановленні URL і після
 *   ротації. Ротація: версія + 1; ще 24 год шлемо обидва підписи.
 * - Підпис: `NCJ-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + тіло)>`,
 *   ключ HMAC = UTF-8 байти всього секрету разом з `whsec_`.
 * - Черга = рядок intros (без нової таблиці, рішення 10 специфікації): зміна
 *   стану знайомства в тому самому пакеті ставить webhook_state = 'pending' і
 *   webhook_next_at = зараз (intros.ts webhookQueue). Доставляє cron кожні 5 хв
 *   (deliverWebhooks) і одразу після відповіді кандидата (webhook-kick.ts).
 * - Спроба спершу «бере» рядок (attempts + 1, next_at = зараз + LEASE) умовним
 *   UPDATE: два паралельні запуски не шлють одну спробу двічі. Невдача: наступна
 *   через 1 хв, 5 хв, 30 хв, 2 год, 12 год; після 6-ї спроби 'failed',
 *   companies.webhook_failing_since і лист власникам (раз). Успіх знімає плашку.
 * - Журнал доставок: рядок audit_log на кожну спробу й тестовий ping з актором
 *   `<company_id>:webhook` (індекс (actor, at): журнал компанії читається
 *   діапазоном, чужі рядки туди не потрапляють). Сторінка Developers його показує.
 */

export const WEBHOOK_EVENTS = ["intro.accepted", "intro.declined", "intro.expired"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export const API_VERSION = "2026-09-12";
export const USER_AGENT = "NextCryptoJob-Webhooks/1";
export const MAX_ATTEMPTS = 6;
/** Пауза після спроби n (1…5) перед спробою n + 1: 1 хв, 5 хв, 30 хв, 2 год, 12 год. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000] as const;
export const DELIVERY_TIMEOUT_MS = 10_000;
/** Скільки секунд отримувач терпить розбіжність часу підпису (openapi: 300 с). */
export const SIGNATURE_TOLERANCE_S = 300;
/** Після ротації старим секретом підписуємо ще стільки. */
export const ROTATION_OVERLAP_MS = 24 * 3_600_000;
/** Скільки знайомств бере один запуск cron. */
export const DELIVER_BATCH = 50;
/** Скільки спроба тримає рядок, щоб інший запуск його не взяв (довше за таймаут). */
const LEASE_MS = 2 * 60_000;
export const URL_MAX = 500;
const OWN_HOSTS = ["nextcryptojob.xyz"];

export const WEBHOOK_ACTOR = (companyId: string) => `${companyId}:webhook`;

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Адреса

/**
 * Чому цей URL не годиться для вебхука (текст для людини), або null.
 * `ownHosts`: наші домени (SITE_URL і nextcryptojob.xyz) разом з піддоменами.
 */
export function webhookUrlProblem(raw: string, ownHosts: readonly string[] = OWN_HOSTS): string | null {
  const text = raw.trim();
  if (text.length > URL_MAX) return `Use a URL of at most ${URL_MAX} characters.`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "Enter a full URL that starts with https://.";
  }
  if (url.protocol !== "https:") return "Use an https:// URL.";
  if (url.username || url.password) return "Remove the user name and password from the URL.";
  if (url.port) return "Use the standard https port (443).";
  const host = url.hostname.toLowerCase();
  if (!isPublicHostname(host)) return "Use a public host name. IP addresses and local names are not allowed.";
  if (ownHosts.some((own) => host === own || host.endsWith(`.${own}`))) {
    return "Use your own endpoint, not a NextCryptoJob address.";
  }
  return null;
}

/** URL, як його зберігаємо: без фрагмента (#…), решта як ввели. */
export function normalizeWebhookUrl(raw: string): string {
  const url = new URL(raw.trim());
  url.hash = "";
  return url.toString();
}

function ownHosts(env: { SITE_URL?: string }): string[] {
  const hosts = new Set(OWN_HOSTS);
  try {
    hosts.add(new URL(siteOrigin(env)).hostname.toLowerCase());
  } catch {
    // Хибний SITE_URL: лишаємо лише свій домен.
  }
  return [...hosts];
}

// ---------------------------------------------------------------------------
// Секрет і підпис

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `whsec_…` для компанії й версії секрету. Той самий ключ і версія завжди дають той самий секрет. */
export async function webhookSecret(signingKey: string, companyId: string, version: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(signingKey), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${companyId}:${version}`));
  return `whsec_${b64url(new Uint8Array(mac))}`;
}

/** Значення NCJ-Signature: `t=<unix>,v1=<hex>[,v1=<hex старого секрету>]`. */
export async function signatureHeader(secrets: readonly string[], body: string, t: number): Promise<string> {
  const parts = [`t=${t}`];
  for (const secret of secrets) parts.push(`v1=${await hmacSha256Hex(secret, `${t}.${body}`)}`);
  return parts.join(",");
}

/**
 * Перевірка підпису так, як це має робити отримувач (приклад на сторінці
 * Developers і тести): хоч один v1 збігається (порівняння сталого часу), а
 * |зараз - t| не більше за SIGNATURE_TOLERANCE_S.
 */
export async function verifySignature(
  header: string,
  rawBody: string,
  secret: string,
  now: Date = new Date(),
  toleranceS = SIGNATURE_TOLERANCE_S,
): Promise<boolean> {
  let t: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === "t" && /^\d+$/.test(v ?? "")) t = Number(v);
    else if (k === "v1" && v) signatures.push(v);
  }
  if (t === null || signatures.length === 0) return false;
  if (Math.abs(Math.floor(now.getTime() / 1000) - t) > toleranceS) return false;
  for (const sig of signatures) {
    if (await hmacSha256Verify(secret, `${t}.${rawBody}`, sig)) return true;
  }
  return false;
}

export interface CompanyHook {
  id: string;
  status: string;
  url: string | null;
  enabled: boolean;
  version: number;
  rotatedAt: string | null;
  failingSince: string | null;
}

type HookRow = {
  id: string;
  status: string;
  webhook_url: string | null;
  webhook_enabled: number;
  webhook_secret_version: number;
  webhook_rotated_at: string | null;
  webhook_failing_since: string | null;
};

const HOOK_COLUMNS = "id, status, webhook_url, webhook_enabled, webhook_secret_version, webhook_rotated_at, webhook_failing_since";

function hookOf(row: HookRow): CompanyHook {
  return {
    id: row.id,
    status: row.status,
    url: row.webhook_url,
    enabled: row.webhook_enabled === 1,
    version: row.webhook_secret_version,
    rotatedAt: row.webhook_rotated_at,
    failingSince: row.webhook_failing_since,
  };
}

export async function loadHook(db: D1Database, companyId: string): Promise<CompanyHook | null> {
  const row = await db.prepare(`SELECT ${HOOK_COLUMNS} FROM companies WHERE id = ?`).bind(companyId).first<HookRow>();
  return row ? hookOf(row) : null;
}

/** Секрети для підпису зараз: чинний і, 24 год після ротації, попередній. */
export async function signingSecrets(signingKey: string, hook: Pick<CompanyHook, "id" | "version" | "rotatedAt">, now: Date): Promise<string[]> {
  const secrets = [await webhookSecret(signingKey, hook.id, hook.version)];
  const rotated = hook.rotatedAt ? Date.parse(`${hook.rotatedAt.replace(" ", "T")}Z`) : NaN;
  if (hook.version > 1 && Number.isFinite(rotated) && now.getTime() - rotated < ROTATION_OVERLAP_MS) {
    secrets.push(await webhookSecret(signingKey, hook.id, hook.version - 1));
  }
  return secrets;
}

function signingKeyOf(env: { WEBHOOK_SIGNING_KEY?: string }): string | null {
  return env.WEBHOOK_SIGNING_KEY?.trim() || null;
}

const notConfigured = () => new ActionError("not_configured", 503, "not configured: WEBHOOK_SIGNING_KEY");

// ---------------------------------------------------------------------------
// Надсилання

export interface SendResult {
  delivered: boolean;
  status_code: number | null;
  error: string | null;
  duration_ms: number;
}

/** Текст помилки для журналу й API: без адреси, без тіла відповіді, до 200 символів. */
function describeFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return `timeout after ${DELIVERY_TIMEOUT_MS / 1000} s`;
  const message = error instanceof Error ? error.message : String(error);
  return `network error: ${message.replace(/https?:\/\/\S+/g, "[url]").slice(0, 160) || "failed"}`;
}

/**
 * Один POST на адресу вебхука: тайм-аут 10 с, без переходів (3xx = невдача),
 * тіло відповіді не читаємо. 2xx = доставлено.
 */
export async function postWebhook(
  url: string,
  body: string,
  headers: Record<string, string>,
  now: () => number = Date.now,
): Promise<SendResult> {
  const started = now();
  try {
    const res = await fetch(url, {
      method: "POST",
      body,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    try {
      await res.body?.cancel();
    } catch {
      // Тіло відповіді нам не потрібне.
    }
    const duration = Math.max(0, now() - started);
    if (res.status >= 200 && res.status < 300) return { delivered: true, status_code: res.status, error: null, duration_ms: duration };
    const error =
      res.status >= 300 && res.status < 400 ? `redirects are not followed (HTTP ${res.status})` : `HTTP ${res.status}`;
    return { delivered: false, status_code: res.status, error, duration_ms: duration };
  } catch (error) {
    return { delivered: false, status_code: null, error: describeFailure(error), duration_ms: Math.max(0, now() - started) };
  }
}

async function signedHeaders(
  secrets: readonly string[],
  body: string,
  o: { eventId: string; type: string; attempt: number; now: Date },
): Promise<Record<string, string>> {
  return {
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
    "NCJ-Signature": await signatureHeader(secrets, body, Math.floor(o.now.getTime() / 1000)),
    "NCJ-Event-Id": o.eventId,
    "NCJ-Event-Type": o.type,
    "NCJ-Delivery-Attempt": String(o.attempt),
  };
}

// ---------------------------------------------------------------------------
// Дії реєстру: get_webhook, set_webhook, test_webhook

type WebhookOut = {
  url: string | null;
  enabled: boolean;
  events: WebhookEvent[];
  failing_since: string | null;
  secret: string | null;
};

function toApi(hook: CompanyHook, secret: string | null = null): WebhookOut {
  return {
    url: hook.url,
    enabled: hook.enabled,
    events: [...WEBHOOK_EVENTS],
    failing_since: isoTime(hook.failingSince),
    secret,
  };
}

function companyOf(ctx: ActionContext): CompanyInfo {
  if (!ctx.company) throw new ActionError("unauthorized", 401, "Sign in or send an API key.");
  return ctx.company;
}

async function hookOrThrow(ctx: ActionContext): Promise<CompanyHook> {
  const hook = await loadHook(ctx.db, companyOf(ctx).id);
  if (!hook) throw new ActionError("not_found", 404, "This company was not found.");
  return hook;
}

export async function getWebhook(ctx: ActionContext): Promise<HandlerResult<WebhookOut>> {
  return { output: toApi(await hookOrThrow(ctx)) };
}

export interface WebhookUpdateInput {
  url?: string;
  enabled?: boolean;
  rotate_secret?: boolean;
}

const invalidUrl = (message: string) =>
  new ActionError("validation_failed", 422, "Some fields are not valid.", { fields: { url: message } });

/**
 * set_webhook: адреса, увімкнення, ротація. Секрет у відповіді лише при першому
 * URL або ротації. Перший URL вмикає вебхук, якщо enabled не сказано. Нова
 * адреса чи повторне ввімкнення знімають плашку "Your webhook is failing".
 */
export async function setWebhook(ctx: ActionContext, input: WebhookUpdateInput): Promise<HandlerResult<WebhookOut>> {
  const key = signingKeyOf(ctx.env);
  if (!key) throw notConfigured();
  const hook = await hookOrThrow(ctx);

  let url = hook.url;
  if (input.url !== undefined) {
    const problem = webhookUrlProblem(input.url, ownHosts(ctx.env));
    if (problem) throw invalidUrl(problem);
    url = normalizeWebhookUrl(input.url);
  }
  const firstUrl = hook.url === null && url !== null;
  const enabled = input.enabled ?? (firstUrl ? true : hook.enabled);
  const rotate = input.rotate_secret === true;
  if ((enabled || rotate) && url === null) throw invalidUrl("Set a webhook URL first.");

  const urlChanged = url !== hook.url;
  const reenabled = enabled && !hook.enabled;
  const at = sqlTime(ctx.now);
  const row = await ctx.db
    .prepare(
      `UPDATE companies
          SET webhook_url = ?, webhook_enabled = ?,
              webhook_secret_version = webhook_secret_version + ?,
              webhook_rotated_at = CASE WHEN ? = 1 THEN ? ELSE webhook_rotated_at END,
              webhook_failing_since = CASE WHEN ? = 1 THEN NULL ELSE webhook_failing_since END,
              updated_at = ?
        WHERE id = ?
       RETURNING ${HOOK_COLUMNS}`,
    )
    .bind(url, enabled ? 1 : 0, rotate ? 1 : 0, rotate ? 1 : 0, at, urlChanged || reenabled ? 1 : 0, at, hook.id)
    .first<HookRow>();
  if (!row) throw new ActionError("not_found", 404, "This company was not found.");
  const saved = hookOf(row);
  const secret = firstUrl || rotate ? await webhookSecret(key, saved.id, saved.version) : null;
  return {
    output: toApi(saved, secret),
    audit: {
      action: rotate ? "webhook.rotate" : "webhook.update",
      target: null,
      meta: { enabled: saved.enabled, url_changed: urlChanged, version: saved.version },
    },
  };
}

/** Рядок журналу доставок (actor `<company_id>:webhook`). */
function deliveryAudit(
  db: D1Database,
  companyId: string,
  action: "webhook.delivery" | "webhook.test",
  target: string | null,
  meta: Record<string, string | number | boolean | null>,
  at: string,
): D1PreparedStatement {
  return db
    .prepare("INSERT INTO audit_log (actor, action, target, meta_json, at) VALUES (?, ?, ?, ?, ?)")
    .bind(WEBHOOK_ACTOR(companyId), action, target, JSON.stringify({ company_id: companyId, ...meta }), at);
}

/**
 * test_webhook: підписаний ping на поточну адресу (навіть коли вебхук
 * вимкнено, щоб перевірити приймач до ввімкнення). Без адреси 409 webhook_not_set.
 */
export async function testWebhook(ctx: ActionContext): Promise<HandlerResult<SendResult>> {
  const hook = await hookOrThrow(ctx);
  // Спершу адреса (409 з договору), потім наш ключ: без ключа адресу й поставити не можна.
  if (!hook.url) throw new ActionError("webhook_not_set", 409, "Set a webhook URL first.");
  const key = signingKeyOf(ctx.env);
  if (!key) throw notConfigured();

  const eventId = `evt_ping_${randomBase62(20)}`;
  const body = JSON.stringify({
    id: eventId,
    type: "ping",
    created_at: isoTime(sqlTime(ctx.now)),
    api_version: API_VERSION,
    company_id: hook.id,
    data: {},
  });
  const problem = webhookUrlProblem(hook.url, ownHosts(ctx.env));
  const result: SendResult = problem
    ? { delivered: false, status_code: null, error: `blocked: ${problem}`, duration_ms: 0 }
    : await postWebhook(
        hook.url,
        body,
        await signedHeaders(await signingSecrets(key, hook, ctx.now), body, { eventId, type: "ping", attempt: 1, now: ctx.now }),
      );
  await deliveryAudit(
    ctx.db,
    hook.id,
    "webhook.test",
    null,
    {
      event: "ping",
      event_id: eventId,
      attempt: 1,
      outcome: result.delivered ? "delivered" : "failed",
      status_code: result.status_code,
      error: result.error,
      duration_ms: result.duration_ms,
      by: auditActor(ctx.actor),
      channel: ctx.channel,
    },
    sqlTime(ctx.now),
  ).run();
  return { output: result, auditWritten: true };
}

// ---------------------------------------------------------------------------
// Доставка подій знайомств (cron і одразу після відповіді)

export interface DeliverOptions {
  /** WEBHOOK_SIGNING_KEY, SITE_URL і канали сповіщень власників. */
  env?: NotifyEnv & { WEBHOOK_SIGNING_KEY?: string };
  notifier?: Notifier;
  now?: Date;
  limit?: number;
}

export interface DeliverResult {
  /** Спроб зроблено. */
  attempted: number;
  delivered: number;
  /** Невдалих спроб, після яких буде ще одна. */
  retrying: number;
  /** Невдалих остаточно (6-та спроба). */
  failed: number;
  /** Вебхук вимкнено чи прибрано: подію знято з черги. */
  dropped: number;
  /** Немає WEBHOOK_SIGNING_KEY: нічого не підписано й не надіслано. */
  skipped: number;
}

type DeliveryRow = IntroRow & {
  company_id: string;
  webhook_event: WebhookEvent | null;
  updated_at: string;
  c_id: string;
  c_status: string;
  c_webhook_url: string | null;
  c_webhook_enabled: number;
  c_webhook_secret_version: number;
  c_webhook_rotated_at: string | null;
  c_webhook_failing_since: string | null;
};

/** Мить події для тіла (стала між спробами): відповідь кандидата або кінець терміну. */
function eventTime(row: DeliveryRow): string {
  if (row.webhook_event === "intro.expired") return row.expires_at;
  return row.responded_at ?? row.updated_at;
}

export function eventId(introId: string, event: WebhookEvent): string {
  return `evt_${introId}_${event.slice("intro.".length)}`;
}

/** Тіло події IntroWebhookEvent з openapi.yaml. */
export function introEventBody(companyId: string, event: WebhookEvent, intro: Intro, createdAt: string, id: string): string {
  return JSON.stringify({ id, type: event, created_at: isoTime(createdAt), api_version: API_VERSION, company_id: companyId, data: { intro } });
}

function failingMessage(origin: string, lastError: string | null): OutgoingMessage {
  const url = new URL("/company/developers", origin).toString();
  const lines = [
    `We could not deliver intro events to your webhook after ${MAX_ATTEMPTS} tries.`,
    ...(lastError ? [`Last error: ${lastError}.`] : []),
    "Fix the endpoint and send a test from the Developers page. Until then your agent can poll list_intros with updated_since.",
  ];
  return {
    telegramHtml: `<b>Your webhook is failing</b>\n\n${lines.map(escapeHtml).join("\n")}\n\n<a href="${escapeHtml(url)}">Open Developers</a>`,
    email: {
      subject: "Your webhook is failing",
      text: `${lines.join("\n\n")}\n\nOpen Developers: ${url}\n`,
      html: `${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("")}<p><a href="${escapeHtml(url)}">Open Developers</a></p>`,
    },
  };
}

/** Лист (або повідомлення бота) усім власникам компанії. Скільки дійшло. */
export async function tellOwners(db: D1Database, companyId: string, message: OutgoingMessage, n: Notifier): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT u.channel, u.telegram_id, u.email FROM company_members m JOIN users u ON u.id = m.user_id
        WHERE m.company_id = ? AND m.role = 'owner' ORDER BY m.id`,
    )
    .bind(companyId)
    .all<{ channel: "email" | "telegram"; telegram_id: string | null; email: string | null }>();
  let sent = 0;
  for (const p of results) {
    const res = await deliver({ channel: p.channel, telegramId: p.telegram_id, email: p.email }, message, n);
    if (res.ok) sent++;
    else console.warn("crm: owner not notified", { companyId, error: res.error });
  }
  return sent;
}

async function loadDelivery(db: D1Database, introId: string): Promise<DeliveryRow | null> {
  const cols = HOOK_COLUMNS.split(", ")
    .map((c) => `c.${c} AS c_${c}`)
    .join(", ");
  return db
    .prepare(
      `SELECT ${INTRO_COLUMNS.split(",").map((c) => `i.${c.trim()}`).join(", ")},
              i.company_id, i.webhook_event, i.updated_at, ${cols}
         FROM intros i JOIN companies c ON c.id = i.company_id
        WHERE i.id = ?`,
    )
    .bind(introId)
    .first<DeliveryRow>();
}

type Outcome = "delivered" | "retrying" | "failed" | "dropped" | "busy";

/**
 * Одна спроба доставити подію знайомства, якщо вона на черзі й її час настав.
 * "busy": рядок уже не на черзі, ще не час або його взяв інший запуск.
 */
export async function deliverIntroWebhook(
  db: D1Database,
  introId: string,
  opts: { signingKey: string; env: NotifyEnv & { SITE_URL?: string }; notifier: Notifier; now: Date },
): Promise<Outcome> {
  const row = await loadDelivery(db, introId);
  const at = sqlTime(opts.now);
  if (!row || row.webhook_state !== "pending" || !row.webhook_event) return "busy";

  const hook = hookOf({
    id: row.c_id,
    status: row.c_status,
    webhook_url: row.c_webhook_url,
    webhook_enabled: row.c_webhook_enabled,
    webhook_secret_version: row.c_webhook_secret_version,
    webhook_rotated_at: row.c_webhook_rotated_at,
    webhook_failing_since: row.c_webhook_failing_since,
  });
  // Вебхук вимкнено, прибрано або компанія вже не активна: подію знято з черги (openapi: state none).
  if (!hook.url || !hook.enabled || hook.status !== "active") {
    const res = await db
      .prepare(
        `UPDATE intros SET webhook_state = 'none', webhook_next_at = NULL, updated_at = ?
          WHERE id = ? AND webhook_state = 'pending' AND webhook_attempts = ?`,
      )
      .bind(at, introId, row.webhook_attempts)
      .run();
    return (res.meta.changes ?? 0) === 1 ? "dropped" : "busy";
  }

  // Узяти спробу: attempts + 1 і оренда рядка на час спроби. Хто не взяв, той не шле.
  const claimed = await db
    .prepare(
      `UPDATE intros SET webhook_attempts = webhook_attempts + 1, webhook_next_at = ?
        WHERE id = ? AND webhook_state = 'pending' AND webhook_attempts = ? AND webhook_next_at <= ?
       RETURNING webhook_attempts`,
    )
    .bind(sqlTime(new Date(opts.now.getTime() + LEASE_MS)), introId, row.webhook_attempts, at)
    .first<{ webhook_attempts: number }>();
  if (!claimed) return "busy";
  const attempt = claimed.webhook_attempts;

  const event = row.webhook_event;
  const id = eventId(row.id, event);
  const intro = projectIntro({ ...row, webhook_attempts: attempt });
  const body = introEventBody(row.company_id, event, intro, eventTime(row), id);
  const problem = webhookUrlProblem(hook.url, ownHosts(opts.env));
  const result: SendResult = problem
    ? { delivered: false, status_code: null, error: `blocked: ${problem}`, duration_ms: 0 }
    : await postWebhook(
        hook.url,
        body,
        await signedHeaders(await signingSecrets(opts.signingKey, hook, opts.now), body, { eventId: id, type: event, attempt, now: opts.now }),
      );

  const outcome: Outcome = result.delivered ? "delivered" : attempt >= MAX_ATTEMPTS ? "failed" : "retrying";
  const mine = "id = ? AND webhook_state = 'pending' AND webhook_attempts = ?";
  const writes: D1PreparedStatement[] = [];
  if (outcome === "delivered") {
    writes.push(
      db
        .prepare(`UPDATE intros SET webhook_state = 'delivered', webhook_next_at = NULL, webhook_last_error = NULL, updated_at = ? WHERE ${mine}`)
        .bind(at, introId, attempt),
      // Приймач знову працює: плашку знімаємо.
      db.prepare("UPDATE companies SET webhook_failing_since = NULL WHERE id = ? AND webhook_failing_since IS NOT NULL").bind(hook.id),
    );
  } else if (outcome === "retrying") {
    const next = sqlTime(new Date(opts.now.getTime() + RETRY_DELAYS_MS[attempt - 1]));
    writes.push(db.prepare(`UPDATE intros SET webhook_next_at = ?, webhook_last_error = ? WHERE ${mine}`).bind(next, result.error, introId, attempt));
  } else {
    writes.push(
      db
        .prepare(`UPDATE intros SET webhook_state = 'failed', webhook_next_at = NULL, webhook_last_error = ?, updated_at = ? WHERE ${mine}`)
        .bind(result.error, at, introId, attempt),
      db.prepare("UPDATE companies SET webhook_failing_since = ? WHERE id = ? AND webhook_failing_since IS NULL").bind(at, hook.id),
    );
  }
  writes.push(
    deliveryAudit(
      db,
      hook.id,
      "webhook.delivery",
      row.user_id,
      {
        intro_id: row.id,
        event,
        event_id: id,
        attempt,
        outcome,
        status_code: result.status_code,
        error: result.error,
        duration_ms: result.duration_ms,
      },
      at,
    ),
  );
  const results = await db.batch(writes);
  // Плашку поставив саме цей запуск: лист власникам рівно раз.
  if (outcome === "failed" && (results[1]?.meta.changes ?? 0) === 1) {
    await tellOwners(db, hook.id, failingMessage(opts.notifier.origin, result.error), opts.notifier);
  }
  return outcome;
}

/**
 * Cron кожні 5 хв: доставити події знайомств, чий час настав (idx_intros_webhook),
 * не більше `limit` за запуск, решту добере наступний. Кожне знайомство окремо:
 * збій одного не зупиняє інших.
 */
export async function deliverWebhooks(db: D1Database, opts: DeliverOptions = {}): Promise<DeliverResult> {
  const now = opts.now ?? new Date();
  const out: DeliverResult = { attempted: 0, delivered: 0, retrying: 0, failed: 0, dropped: 0, skipped: 0 };
  const env = opts.env ?? {};
  const { results } = await db
    .prepare("SELECT id FROM intros WHERE webhook_state = 'pending' AND webhook_next_at <= ? ORDER BY webhook_next_at LIMIT ?")
    .bind(sqlTime(now), opts.limit ?? DELIVER_BATCH)
    .all<{ id: string }>();
  if (results.length === 0) return out;
  const signingKey = signingKeyOf(env);
  if (!signingKey) {
    // Підписати нічим: не витрачаємо спроб компаній через наше налаштування.
    console.error("webhooks: not configured: WEBHOOK_SIGNING_KEY", { waiting: results.length });
    out.skipped = results.length;
    return out;
  }
  const notifier = opts.notifier ?? notifierFromEnv(env);
  for (const { id } of results) {
    let outcome: Outcome;
    try {
      outcome = await deliverIntroWebhook(db, id, { signingKey, env, notifier, now });
    } catch (error) {
      console.error("webhooks: delivery crashed", { introId: id, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (outcome === "busy") continue;
    if (outcome !== "dropped") out.attempted++;
    out[outcome]++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Для сторінки Developers

export interface DeliveryLogRow {
  at: string;
  kind: "delivery" | "test";
  event: string;
  eventId: string | null;
  introId: string | null;
  attempt: number | null;
  outcome: "delivered" | "retrying" | "failed";
  statusCode: number | null;
  error: string | null;
  durationMs: number | null;
}

/** Останні спроби доставки й тестові ping цієї компанії, новіші першими. */
export async function recentDeliveries(db: D1Database, companyId: string, limit = 20): Promise<DeliveryLogRow[]> {
  const { results } = await db
    .prepare("SELECT action, meta_json, at FROM audit_log WHERE actor = ? ORDER BY at DESC, id DESC LIMIT ?")
    .bind(WEBHOOK_ACTOR(companyId), limit)
    .all<{ action: string; meta_json: string | null; at: string }>();
  return results.flatMap((r) => {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(r.meta_json ?? "{}") as Record<string, unknown>;
    } catch {
      return [];
    }
    const outcome = m.outcome === "delivered" || m.outcome === "retrying" || m.outcome === "failed" ? m.outcome : "failed";
    return [
      {
        at: r.at,
        kind: r.action === "webhook.test" ? "test" : "delivery",
        event: typeof m.event === "string" ? m.event : "ping",
        eventId: typeof m.event_id === "string" ? m.event_id : null,
        introId: typeof m.intro_id === "string" ? m.intro_id : null,
        attempt: typeof m.attempt === "number" ? m.attempt : null,
        outcome,
        statusCode: typeof m.status_code === "number" ? m.status_code : null,
        error: typeof m.error === "string" ? m.error : null,
        durationMs: typeof m.duration_ms === "number" ? m.duration_ms : null,
      },
    ];
  });
}

/** Скільки подій чекає на повтор і скільки не доставлено остаточно. */
export async function webhookQueueCounts(db: D1Database, companyId: string): Promise<{ pending: number; failed: number }> {
  const row = await db
    .prepare(
      `SELECT SUM(webhook_state = 'pending') AS pending, SUM(webhook_state = 'failed') AS failed
         FROM intros WHERE company_id = ? AND webhook_state IN ('pending', 'failed')`,
    )
    .bind(companyId)
    .first<{ pending: number | null; failed: number | null }>();
  return { pending: row?.pending ?? 0, failed: row?.failed ?? 0 };
}
