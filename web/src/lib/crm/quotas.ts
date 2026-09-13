import { fromSqlTime, isoTime, sqlTime, startOfUtcDay, startOfUtcMonth } from "@/lib/time";
import type { Actor, Channel, CompanyInfo, CrmEnv, Plan, SubscriptionInfo } from "./context";
import { ActionError } from "./types";

/**
 * Квоти й ліміти (специфікація CRM, розділ 9).
 *
 * Денні й місячні квоти рахуються в D1: COUNT(*) по usage_events (індекс
 * (company_id, action, created_at)), лише успішні виклики (статус 2xx).
 * Доба за UTC; місяць за періодом підписки Stripe, для manual і usdc за
 * календарним місяцем UTC. Сплески ріже Workers Rate Limiting (RL_*): його
 * лічильник приблизний, тому він не замінює квот.
 *
 * Бронювання атомарне: рядок usage_events пишеться однією інструкцією
 * INSERT … SELECT … WHERE COUNT(*) < межа ДО дії, зі статусом 200. Паралельні
 * запити бачать лічильник по черзі, тож квоту не перебрати. Якщо дія впала,
 * finishUsage ставить справжній статус, і рядок перестає рахуватись.
 */

/** Дії з квотою і вікна. Назви ключів збігаються з Account.quotas в openapi.yaml. */
export const QUOTA_NAMES = ["search_candidates", "get_candidate", "request_intro_day", "request_intro_month"] as const;
export type QuotaName = (typeof QUOTA_NAMES)[number];

const QUOTA_DEFS: Record<QuotaName, { action: MeteredAction; window: "day" | "month" }> = {
  search_candidates: { action: "search_candidates", window: "day" },
  get_candidate: { action: "get_candidate", window: "day" },
  request_intro_day: { action: "request_intro", window: "day" },
  request_intro_month: { action: "request_intro", window: "month" },
};

export type MeteredAction = "search_candidates" | "get_candidate" | "request_intro";
export type QuotaPlan = Exclude<Plan, "none"> | "guest";

/** Межі з таблиці розділу 9. undefined = без межі (null в Account.quotas); 0 = дія недоступна. */
const LIMITS: Record<QuotaPlan, Partial<Record<QuotaName, number>>> = {
  subscription: { search_candidates: 300, get_candidate: 200, request_intro_day: 10, request_intro_month: 40 },
  // «5 за весь пробний»: пробний Stripe це один період, тож місячне вікно = увесь пробний.
  trial: { search_candidates: 50, get_candidate: 50, request_intro_day: 3, request_intro_month: 5 },
  pay_per_request: { search_candidates: 200, get_candidate: 100, request_intro_day: 10 },
  // Гість x402: 50 сторінок пошуку на добу на адресу платника; решта недоступна.
  guest: { search_candidates: 50 },
};

/** Місця (розділ 9): скільки чого може мати компанія одночасно. */
export const SEATS: Record<Exclude<QuotaPlan, "guest">, { savedSearches: number; openJobs: number; members: number; apiKeys: number }> =
  {
    subscription: { savedSearches: 20, openJobs: 10, members: 5, apiKeys: 5 },
    trial: { savedSearches: 5, openJobs: 2, members: 5, apiKeys: 2 },
    pay_per_request: { savedSearches: 0, openJobs: 0, members: 2, apiKeys: 5 },
  };

export function quotaPlan(actor: Actor, company: CompanyInfo | null): QuotaPlan | null {
  if (actor.kind === "x402_guest") return "guest";
  if (!company || company.plan === "none") return null;
  return company.plan;
}

export function quotaLimit(plan: QuotaPlan, name: QuotaName): number | null {
  return LIMITS[plan][name] ?? null;
}

/** Хто витрачає квоту: компанія або гість за адресою платника. */
export type QuotaSubject = { companyId: string } | { payer: string };

export interface QuotaWindow {
  /** Початок вікна, час SQLite. */
  start: string;
  /** Коли вікно скидається. */
  resetsAt: Date;
}

export function dayWindow(now: Date): QuotaWindow {
  const start = startOfUtcDay(now);
  return { start: sqlTime(start), resetsAt: new Date(start.getTime() + 86_400_000) };
}

/**
 * Місячне вікно: період підписки Stripe (current_period_start…end), інакше
 * календарний місяць UTC (manual, usdc, або період невідомий).
 */
export function monthWindow(now: Date, subscription: SubscriptionInfo | null): QuotaWindow {
  if (subscription?.provider === "stripe" && subscription.periodStart && subscription.periodEnd) {
    return { start: subscription.periodStart, resetsAt: fromSqlTime(subscription.periodEnd) };
  }
  const start = startOfUtcMonth(now);
  return { start: sqlTime(start), resetsAt: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)) };
}

export interface QuotaState {
  name: QuotaName;
  /** null = без межі. */
  limit: number | null;
  /** null = без межі. */
  remaining: number | null;
  resetsAt: Date;
  /** Секунд до скидання (для RateLimit-Reset і Retry-After). */
  resetSeconds: number;
}

function subjectSql(subject: QuotaSubject): { sql: string; param: string } {
  return "companyId" in subject
    ? { sql: "company_id = ?", param: subject.companyId }
    : { sql: "company_id IS NULL AND payer = ?", param: subject.payer };
}

/** COUNT(*) успішних викликів дії від початку вікна. */
function countStatement(db: D1Database, subject: QuotaSubject, action: MeteredAction, since: string) {
  const s = subjectSql(subject);
  return db
    .prepare(
      `SELECT COUNT(*) AS used FROM usage_events
        WHERE ${s.sql} AND action = ? AND status BETWEEN 200 AND 299 AND created_at >= ?`,
    )
    .bind(s.param, action, since);
}

function state(name: QuotaName, limit: number | null, used: number, window: QuotaWindow, now: Date): QuotaState {
  return {
    name,
    limit,
    remaining: limit === null ? null : Math.max(0, limit - used),
    resetsAt: window.resetsAt,
    resetSeconds: Math.max(0, Math.ceil((window.resetsAt.getTime() - now.getTime()) / 1000)),
  };
}

/** Стан усіх квот для get_account (Account.quotas). */
export async function quotaStates(
  db: D1Database,
  subject: QuotaSubject,
  plan: QuotaPlan,
  subscription: SubscriptionInfo | null,
  now: Date,
): Promise<QuotaState[]> {
  const windows = QUOTA_NAMES.map((name) =>
    QUOTA_DEFS[name].window === "day" ? dayWindow(now) : monthWindow(now, subscription),
  );
  const counts = await db.batch<{ used: number }>(
    QUOTA_NAMES.map((name, i) => countStatement(db, subject, QUOTA_DEFS[name].action, windows[i].start)),
  );
  return QUOTA_NAMES.map((name, i) =>
    state(name, quotaLimit(plan, name), counts[i].results[0]?.used ?? 0, windows[i], now),
  );
}

/** Account.quotas: { limit, remaining, resets_at } на кожну квоту. */
export function quotasForAccount(states: QuotaState[]) {
  return Object.fromEntries(
    states.map((s) => [s.name, { limit: s.limit, remaining: s.remaining, resets_at: isoTime(sqlTime(s.resetsAt)) }]),
  );
}

/** Заголовки денної квоти дії (openapi: RateLimit-Limit/Remaining/Reset, UTC). */
export function rateLimitHeaders(quota: QuotaState): Record<string, string> {
  if (quota.limit === null || quota.remaining === null) return {};
  return {
    "RateLimit-Limit": String(quota.limit),
    "RateLimit-Remaining": String(quota.remaining),
    "RateLimit-Reset": String(quota.resetSeconds),
  };
}

/** Те саме для MCP: `_meta["ncj/quota"]`. */
export function quotaMeta(quota: QuotaState) {
  return { "ncj/quota": { limit: quota.limit, remaining: quota.remaining, reset_seconds: quota.resetSeconds } };
}

export interface UsageRecord {
  subject: QuotaSubject;
  action: string;
  channel: Channel;
  billing: "included" | "x402" | "free";
  apiKeyId?: string | null;
  memberUserId?: string | null;
  payer?: string | null;
  paymentId?: string | null;
  status?: number;
  results?: number | null;
}

function usageValues(r: UsageRecord, now: Date) {
  return [
    "companyId" in r.subject ? r.subject.companyId : null,
    r.apiKeyId ?? null,
    r.memberUserId ?? null,
    "payer" in r.subject ? r.subject.payer : (r.payer ?? null),
    r.channel,
    r.action,
    r.billing,
    r.paymentId ?? null,
    r.status ?? 200,
    r.results ?? null,
    sqlTime(now),
  ];
}

const USAGE_COLUMNS =
  "company_id, api_key_id, member_user_id, payer, channel, action, billing, x402_payment_id, status, results, created_at";

/** Рядок usage_events для дії без квоти (пишеться після виконання, в одному пакеті з журналом). */
export function usageStatement(db: D1Database, record: UsageRecord, now: Date): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO usage_events (${USAGE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(...usageValues(record, now));
}

export type Reservation =
  | { ok: true; usageId: number; quotas: QuotaState[] }
  | { ok: false; exceeded: QuotaState; quotas: QuotaState[] };

/**
 * Бронює один виклик дії з квотою: перевірка всіх меж і запис рядка
 * usage_events (статус 200) однією інструкцією. Відмова, якщо хоч одна межа
 * вичерпана або дорівнює 0. Лічильник і бронь ідуть одним пакетом (транзакцією).
 */
export async function reserveUsage(
  db: D1Database,
  record: UsageRecord,
  plan: QuotaPlan,
  quotaNames: readonly QuotaName[],
  subscription: SubscriptionInfo | null,
  now: Date,
): Promise<Reservation> {
  const windows = quotaNames.map((name) =>
    QUOTA_DEFS[name].window === "day" ? dayWindow(now) : monthWindow(now, subscription),
  );
  const limits = quotaNames.map((name) => quotaLimit(plan, name));
  const s = subjectSql(record.subject);

  // Умова на кожну межу: (межа IS NULL) OR (COUNT(*) з початку вікна < межа).
  const guards: string[] = [];
  const guardParams: (string | number | null)[] = [];
  quotaNames.forEach((name, i) => {
    guards.push(
      `(? IS NULL OR (SELECT COUNT(*) FROM usage_events
                       WHERE ${s.sql} AND action = ? AND status BETWEEN 200 AND 299 AND created_at >= ?) < ?)`,
    );
    guardParams.push(limits[i], s.param, QUOTA_DEFS[name].action, windows[i].start, limits[i]);
  });

  const counts = quotaNames.map((name, i) => countStatement(db, record.subject, QUOTA_DEFS[name].action, windows[i].start));
  const insert = db
    .prepare(
      `INSERT INTO usage_events (${USAGE_COLUMNS})
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE ${guards.length ? guards.join(" AND ") : "1"}
       RETURNING id`,
    )
    .bind(...usageValues(record, now), ...guardParams);

  const results = await db.batch<{ used?: number; id?: number }>([...counts, insert]);
  const used = quotaNames.map((_, i) => results[i].results[0]?.used ?? 0);
  const inserted = results[quotaNames.length].results[0]?.id;

  if (inserted === undefined) {
    const quotas = quotaNames.map((name, i) => state(name, limits[i], used[i], windows[i], now));
    const exceeded = quotas.find((q) => q.limit !== null && q.remaining === 0) ?? quotas[0];
    return { ok: false, exceeded, quotas };
  }
  // Лічильник прочитано до броні, тож разом з нею використано used + 1.
  const quotas = quotaNames.map((name, i) => state(name, limits[i], used[i] + 1, windows[i], now));
  return { ok: true, usageId: inserted, quotas };
}

/** Справжній статус і кількість результатів після дії. Статус не 2xx знімає бронь з квоти. */
export function finishUsageStatement(
  db: D1Database,
  usageId: number,
  status: number,
  results: number | null,
): D1PreparedStatement {
  return db.prepare("UPDATE usage_events SET status = ?, results = ? WHERE id = ?").bind(status, results, usageId);
}

const EXCEEDED_TEXT: Record<QuotaName, string> = {
  search_candidates: "Daily search limit reached. It resets at 00:00 UTC.",
  get_candidate: "Daily profile view limit reached. It resets at 00:00 UTC.",
  request_intro_day: "Daily intro limit reached. It resets at 00:00 UTC.",
  request_intro_month: "Monthly intro limit reached.",
};

/**
 * Помилка вичерпаної квоти: денна → 429 daily_quota_exceeded з RateLimit-* і
 * Retry-After; місячна → 403 quota_exceeded; межа 0 (дія не входить у план) → 403.
 */
export function quotaError(quota: QuotaState, plan: QuotaPlan): ActionError {
  const def = QUOTA_DEFS[quota.name];
  if (quota.limit === 0) {
    return new ActionError("subscription_required", 403, "This action needs a subscription.");
  }
  if (def.window === "month") {
    const text =
      plan === "trial"
        ? "Trial intro limit reached. Subscribe to request more intros."
        : `${EXCEEDED_TEXT[quota.name]} It resets on ${isoTime(sqlTime(quota.resetsAt)).slice(0, 10)}.`;
    return new ActionError("quota_exceeded", 403, text, {
      quota: quota.name,
      limit: quota.limit,
      resets_at: isoTime(sqlTime(quota.resetsAt)),
    });
  }
  return new ActionError(
    "daily_quota_exceeded",
    429,
    EXCEEDED_TEXT[quota.name],
    { quota: quota.name, limit: quota.limit, resets_at: isoTime(sqlTime(quota.resetsAt)) },
    { ...rateLimitHeaders(quota), "Retry-After": String(quota.resetSeconds) },
  );
}

// ---------------------------------------------------------------------------
// Сплески (Workers Rate Limiting)

/**
 * Ліміт сплесків: 60/хв на ключ (RL_API), 120/хв на сесію (RL_WEB), 10/хв на IP
 * для гостя (RL_IP). Без прив'язки (next dev, тести) пропускає.
 */
export async function checkBurst(env: CrmEnv, actor: Actor, ip: string): Promise<void> {
  const [binding, key] =
    actor.kind === "agent"
      ? [env.RL_API, `key:${actor.keyId}`]
      : actor.kind === "member" || actor.kind === "admin"
        ? [env.RL_WEB, `user:${actor.userId}`]
        : [env.RL_IP, `ip:${ip}`];
  await limitOrThrow(binding, key);
}

/** Публічний search_jobs: 30/хв на IP (RL_PUBLIC, розділ 9). Без прив'язки пропускає. */
export async function checkPublicBurst(env: CrmEnv, ip: string): Promise<void> {
  await limitOrThrow(env.RL_PUBLIC, `ip:${ip}`);
}

async function limitOrThrow(binding: RateLimit | undefined, key: string): Promise<void> {
  if (!binding) return;
  const { success } = await binding.limit({ key });
  if (!success) {
    throw new ActionError("rate_limited", 429, "Too many requests. Slow down and try again in a minute.", undefined, {
      "Retry-After": "60",
    });
  }
}
