import { cookies } from "next/headers";
import { sha256Hex } from "@/lib/auth/hash";
import { currentUser } from "@/lib/auth/session";
import { appEnv, db } from "@/lib/db";
import type { X402Env } from "@/lib/x402/config";
import type { ActorRole } from "./permissions";
import { ActionError } from "./types";

/**
 * Хто діє і від імені якої компанії (специфікація CRM, 3.3 і 2.3).
 *
 * Порядок:
 * 1. `Authorization: Bearer ncj_live_…` → SHA-256 → api_keys.key_hash → компанія ключа.
 *    Ключа немає → 401 invalid_api_key; відкликаний → 401 key_revoked.
 * 2. Інакше сесія входу, лише в каналі web (REST і MCP кук не приймають) →
 *    company_members (компанія з кукі `ncj_company`, інакше та, де людина була востаннє).
 * 3. Інакше платіж x402 (PAYMENT-SIGNATURE або `_meta["x402/payment"]`) → гість;
 *    адресу платника дає verify пізніше.
 * 4. Інакше 401 unauthorized.
 *
 * Ядро (`resolveActor`) бере базу й дані запиту аргументами: так його перевіряє
 * тест і так ним користуються маршрути REST і MCP. `resolveWebActor` додає
 * куки Next для server actions інтерфейсу.
 */

export type Channel = "web" | "rest" | "mcp";
export type AccessMode = "subscription" | "pay_per_request" | "none";
/** Доступ з урахуванням пробного періоду: від нього залежать квоти (розділ 9). */
export type Plan = "subscription" | "trial" | "pay_per_request" | "none";

export const COMPANY_COOKIE = "ncj_company";
export const API_KEY_PREFIX = "ncj_live_";
const API_KEY_SHAPE = /^ncj_live_[A-Za-z0-9]{43}$/;

export interface SubscriptionInfo {
  id: string;
  provider: "stripe" | "usdc" | "manual";
  status: string;
  /** Час SQLite (UTC) або null. */
  periodStart: string | null;
  periodEnd: string | null;
}

export interface CompanyInfo {
  id: string;
  name: string;
  kind: "company" | "agency";
  status: "pending_review" | "active" | "suspended" | "rejected" | "closed";
  domainVerified: boolean;
  access: AccessMode;
  plan: Plan;
  /** Підписка, що дає доступ зараз; null, якщо доступу за підпискою немає. */
  subscription: SubscriptionInfo | null;
  /** Статус найновішої підписки (для «Payment failed» тощо), навіть коли вона вже не дає доступу. */
  latestStatus: string | null;
}

export type Actor =
  | { kind: "member"; role: "owner" | "member"; userId: string; companyId: string }
  | { kind: "agent"; keyId: string; keyName: string; keyPrefix: string; companyId: string }
  | { kind: "x402_guest"; payer: string | null; paymentId: string | null }
  | { kind: "admin"; userId: string };

/** Змінні оточення, які читає CRM. Секрети лише як рядки; відсутні = undefined. */
export type CrmEnv = X402Env & {
  SESSION_SECRET?: string;
  RL_API?: RateLimit;
  RL_WEB?: RateLimit;
  RL_IP?: RateLimit;
  /** Сповіщення про знайомства (notify.ts): бот, пошта, адреса сайту для посилань. */
  TELEGRAM_BOT_TOKEN?: string;
  EMAIL?: SendEmail;
  SITE_URL?: string;
};

export interface ActionContext {
  db: D1Database;
  actor: Actor;
  /** Компанія актора; null для гостя x402 і адміна. */
  company: CompanyInfo | null;
  channel: Channel;
  requestId: string;
  /** Мить запиту: межі денних і місячних квот рахуються від неї. */
  now: Date;
  env: CrmEnv;
  /**
   * Платіж x402, яким оплачено цей виклик (після verify і settle). Ставить
   * run() з броні; обробник пише його id у свій рядок (intros.x402_payment_id).
   */
  payment?: { id: string; payer: string | null } | null;
}

export function actorRole(actor: Actor): ActorRole {
  switch (actor.kind) {
    case "member":
      return actor.role;
    case "agent":
      return "agent";
    case "x402_guest":
      return "x402_guest";
    case "admin":
      return "admin";
  }
}

/** Id компанії актора або null (гість, адмін). */
export function actorCompanyId(actor: Actor): string | null {
  return actor.kind === "member" || actor.kind === "agent" ? actor.companyId : null;
}

// ---------------------------------------------------------------------------
// Компанія й доступ

/**
 * Та сама умова, що в поданні company_access (0012_access_views): підписка, яка дає доступ зараз.
 * past_due: 7 діб від початку періоду з невдалим списанням; рядок без кінця періоду доступу не дає.
 * Тест lib/billing/access.test.ts звіряє її з поданням.
 */
const GRANTING_SUBSCRIPTION = `
  (s2.status IN ('trialing', 'active')
     AND datetime(s2.current_period_end,
                  CASE s2.provider WHEN 'stripe' THEN '+2 days' ELSE '+0 days' END) > datetime('now'))
  OR (s2.status = 'past_due' AND datetime(s2.current_period_start, '+7 days') > datetime('now'))`;

type CompanyRow = {
  id: string;
  name: string;
  kind: CompanyInfo["kind"];
  status: CompanyInfo["status"];
  domain_verified: number;
  access: AccessMode;
  latest_status: string | null;
  sub_id: string | null;
  provider: SubscriptionInfo["provider"] | null;
  sub_status: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
};

/** Компанія з доступом і чинною підпискою; null, якщо такої немає. */
export async function loadCompany(db: D1Database, companyId: string): Promise<CompanyInfo | null> {
  const row = await db
    .prepare(
      `SELECT c.id, c.name, c.kind, c.status, (c.domain_verified_at IS NOT NULL) AS domain_verified,
              a.access, a.latest_status,
              s.id AS sub_id, s.provider, s.status AS sub_status, s.current_period_start, s.current_period_end
         FROM companies c
         JOIN company_access a ON a.company_id = c.id
         LEFT JOIN subscriptions s ON s.id = (
           SELECT s2.id FROM subscriptions s2
            WHERE s2.company_id = c.id AND (${GRANTING_SUBSCRIPTION})
            ORDER BY (s2.status = 'active') DESC, (s2.status = 'trialing') DESC, s2.current_period_end DESC
            LIMIT 1)
        WHERE c.id = ?`,
    )
    .bind(companyId)
    .first<CompanyRow>();
  if (!row) return null;

  const subscription: SubscriptionInfo | null =
    row.access === "subscription" && row.sub_id && row.provider && row.sub_status
      ? {
          id: row.sub_id,
          provider: row.provider,
          status: row.sub_status,
          periodStart: row.current_period_start,
          periodEnd: row.current_period_end,
        }
      : null;
  const plan: Plan =
    row.access === "subscription" ? (subscription?.status === "trialing" ? "trial" : "subscription") : row.access;

  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    domainVerified: row.domain_verified === 1,
    access: row.access,
    plan,
    subscription,
    latestStatus: row.latest_status,
  };
}

// ---------------------------------------------------------------------------
// Актор

export interface ActorRequest {
  channel: Channel;
  /** Значення заголовка Authorization, як прийшло. */
  authorization?: string | null;
  /** Чи є платіж x402 у запиті (сам платіж перевіряє шлюз x402). */
  hasPayment?: boolean;
  /** Людина з сесії входу (currentUser), якщо є. */
  sessionUserId?: string | null;
  /** Бажана компанія з кукі `ncj_company`. */
  companyId?: string | null;
}

export interface ContextBase {
  db: D1Database;
  env: CrmEnv;
  requestId?: string;
  now?: Date;
}

/** База й оточення Worker для контексту дії. Викликати лише під час запиту. */
export function crmBase(requestId?: string): ContextBase {
  return { db: db(), env: appEnv() as unknown as CrmEnv, requestId };
}

/** Контекст дії або ActionError 401. */
export async function resolveActor(base: ContextBase, request: ActorRequest): Promise<ActionContext> {
  const ctx = {
    db: base.db,
    env: base.env,
    channel: request.channel,
    requestId: base.requestId ?? crypto.randomUUID(),
    now: base.now ?? new Date(),
  };

  const auth = request.authorization?.trim();
  if (auth) {
    const agent = await agentFromKey(base.db, auth);
    const company = await loadCompany(base.db, agent.companyId);
    if (!company) throw new ActionError("invalid_api_key", 401, "This API key is not valid.");
    return { ...ctx, actor: agent, company };
  }

  if (request.sessionUserId && request.channel === "web") {
    const member = await memberFromSession(base.db, request.sessionUserId, request.companyId ?? null);
    if (member) {
      const company = await loadCompany(base.db, member.companyId);
      if (company) return { ...ctx, actor: member, company };
    }
    if (!request.hasPayment) {
      throw new ActionError("unauthorized", 401, "This account is not a member of a company yet.");
    }
  }

  if (request.hasPayment) {
    return { ...ctx, actor: { kind: "x402_guest", payer: null, paymentId: null }, company: null };
  }
  throw new ActionError("unauthorized", 401, "Sign in or send an API key.");
}

async function agentFromKey(db: D1Database, authorization: string): Promise<Extract<Actor, { kind: "agent" }>> {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  const key = match?.[1];
  // Хибну форму навіть не хешуємо: ключ завжди ncj_live_ + 43 символи base62.
  if (!key || !API_KEY_SHAPE.test(key)) {
    throw new ActionError("invalid_api_key", 401, "This API key is not valid.");
  }
  const row = await db
    .prepare(
      `SELECT id, name, prefix, company_id, revoked_at,
              (last_used_at IS NULL OR last_used_at < datetime('now', '-5 minutes')) AS stale
         FROM api_keys WHERE key_hash = ?`,
    )
    .bind(await sha256Hex(key))
    .first<{ id: string; name: string; prefix: string; company_id: string; revoked_at: string | null; stale: number }>();
  if (!row) throw new ActionError("invalid_api_key", 401, "This API key is not valid.");
  if (row.revoked_at) throw new ActionError("key_revoked", 401, "This API key was revoked.");

  // last_used_at не частіше разу на 5 хв: запис на кожен запит коштував би більше за точність.
  if (row.stale) {
    await db
      .prepare(
        `UPDATE api_keys SET last_used_at = datetime('now')
          WHERE id = ? AND (last_used_at IS NULL OR last_used_at < datetime('now', '-5 minutes'))`,
      )
      .bind(row.id)
      .run();
  }
  return { kind: "agent", keyId: row.id, keyName: row.name, keyPrefix: row.prefix, companyId: row.company_id };
}

async function memberFromSession(
  db: D1Database,
  userId: string,
  preferredCompany: string | null,
): Promise<Extract<Actor, { kind: "member" }> | null> {
  const row = await db
    .prepare(
      `SELECT company_id, role FROM company_members
        WHERE user_id = ?
        ORDER BY (company_id = ?) DESC, last_seen_at IS NULL, last_seen_at DESC, joined_at DESC, id DESC
        LIMIT 1`,
    )
    .bind(userId, preferredCompany ?? "")
    .first<{ company_id: string; role: "owner" | "member" }>();
  return row ? { kind: "member", role: row.role, userId, companyId: row.company_id } : null;
}

/**
 * Контекст для server actions інтерфейсу: сесія з куки, компанія з кукі `ncj_company`.
 * Після зміни компанії чи входу сторінка має викликати router.refresh() (кеш роутера Next).
 */
export async function resolveWebActor(base: ContextBase = crmBase()): Promise<ActionContext> {
  const user = await currentUser();
  const companyId = (await cookies()).get(COMPANY_COOKIE)?.value ?? null;
  return resolveActor(base, { channel: "web", sessionUserId: user?.id ?? null, companyId });
}
