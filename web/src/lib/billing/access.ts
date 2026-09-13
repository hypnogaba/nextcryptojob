/**
 * Доступ компанії до CRM (специфікація CRM, 2.3 і 4.2).
 *
 * Хто має доступ, каже одне SQL-подання `company_access` (0012_access_views):
 * Stripe (`trialing`/`active` до кінця періоду + 2 доби на запізнілий вебхук,
 * `past_due` 7 діб від початку періоду з невдалим списанням), ручний доступ від адміна (`provider = 'manual'`) і
 * оплачені USDC-періоди x402 (`provider = 'usdc'`). Тут лише читання подання
 * і того, що бачить сторінка оплати; власного правила доступу модуль не має.
 */

export type AccessMode = "subscription" | "pay_per_request" | "none";
export type Provider = "stripe" | "usdc" | "manual";

/**
 * Та сама умова, що в поданні company_access (0012_access_views): підписка, яка
 * дає доступ зараз. Потрібна, щоб знайти саме рядок (подання дає лише так/ні);
 * тест звіряє, що подання, ця умова і crm/context.ts завжди згодні.
 * past_due: 7 діб від початку періоду, у якому не пройшло списання.
 */
const GRANTING = `
  ((s.status IN ('trialing', 'active')
     AND datetime(s.current_period_end,
                  CASE s.provider WHEN 'stripe' THEN '+2 days' ELSE '+0 days' END) > datetime('now'))
   OR (s.status = 'past_due' AND datetime(s.current_period_start, '+7 days') > datetime('now')))`;

/** Статуси Stripe, за яких підписка ще жива: друга через Checkout була б дублем. */
export const OPEN_STRIPE_STATUSES = ["trialing", "active", "past_due", "unpaid", "paused"] as const;

/**
 * Що скасувати в Stripe, коли компанію закрито: живі й `incomplete` (перший платіж
 * ще чекає 3-D Secure і може пройти вже після закриття). Доступу `incomplete` не
 * дає, тож OPEN_STRIPE_STATUSES (дубль Checkout, доступ) його не містить.
 */
export const CANCEL_ON_CLOSE_STRIPE_STATUSES = [...OPEN_STRIPE_STATUSES, "incomplete"] as const;

export interface CompanyAccess {
  access: AccessMode;
  /** Статус найновішої підписки будь-якого провайдера (для плашок), або null. */
  latestStatus: string | null;
}

/** Рядок подання company_access; null, якщо компанії немає. */
export async function companyAccess(db: D1Database, companyId: string): Promise<CompanyAccess | null> {
  const row = await db
    .prepare("SELECT access, latest_status FROM company_access WHERE company_id = ?")
    .bind(companyId)
    .first<{ access: AccessMode; latest_status: string | null }>();
  return row ? { access: row.access, latestStatus: row.latest_status } : null;
}

/**
 * Чи має компанія доступ за підпискою (Stripe, ручний або USDC-період).
 * `pay_per_request` це не доступ: так працює лише API з оплатою x402 за запит.
 */
export async function hasAccess(db: D1Database, companyId: string): Promise<boolean> {
  return (await companyAccess(db, companyId))?.access === "subscription";
}

/**
 * Чи був пробний період у компанії або в людини: пробний дається раз на
 * компанію і раз на людину. Рахуються Stripe (trial_end стоїть назавжди, навіть
 * після скасування) і ручний `trialing` від адміна (manual.ts ставить trial_end)
 * у цій компанії та в усіх компаніях, де людина власник або яку вона створила.
 * Інакше пробний можна брати знову й знову, щоразу створюючи нову компанію.
 */
const HAD_TRIAL = `
  SELECT 1 AS yes FROM subscriptions s
   WHERE (s.trial_end IS NOT NULL OR s.status = 'trialing')
     AND (s.company_id = ?1
          OR s.company_id IN (SELECT m.company_id FROM company_members m WHERE m.user_id = ?2 AND m.role = 'owner')
          OR s.company_id IN (SELECT c.id FROM companies c WHERE c.created_by = ?2))
   LIMIT 1`;

export async function hadTrial(db: D1Database, companyId: string, userId: string | null = null): Promise<boolean> {
  return (await db.prepare(HAD_TRIAL).bind(companyId, userId).first()) !== null;
}

export interface SubscriptionView {
  id: string;
  provider: Provider;
  status: string;
  /** Час SQLite (UTC) або null. */
  periodEnd: string | null;
  trialEnd: string | null;
  cancelAt: string | null;
  canceledAt: string | null;
  note: string | null;
}

export interface BillingState {
  companyId: string;
  companyName: string;
  companyStatus: string;
  /** companies.billing_email, якщо власник задав окрему пошту для рахунків. */
  billingEmail: string | null;
  access: AccessMode;
  /** Підписка, що дає доступ зараз (та сама, що обирає CRM); null, якщо немає. */
  current: SubscriptionView | null;
  /** Найновіша підписка Stripe будь-якого статусу (плашка "Payment failed", портал). */
  stripe: (SubscriptionView & { customerId: string | null }) | null;
  /** Є хоч одна жива підписка Stripe (не лише найновіша): замість Checkout веди в портал. */
  stripeOpen: boolean;
  /** Клієнт Stripe для порталу: з будь-якої підписки компанії. */
  stripeCustomerId: string | null;
  /** Пробний ще не використано ні компанією, ні людиною, що дивиться (hadTrial). */
  trialAvailable: boolean;
}

type SubRow = {
  id: string;
  provider: Provider;
  status: string;
  current_period_end: string | null;
  trial_end: string | null;
  cancel_at: string | null;
  canceled_at: string | null;
  note: string | null;
  stripe_customer_id: string | null;
};

const SUB_COLUMNS =
  "s.id, s.provider, s.status, s.current_period_end, s.trial_end, s.cancel_at, s.canceled_at, s.note, s.stripe_customer_id";

function view(row: SubRow): SubscriptionView {
  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    periodEnd: row.current_period_end,
    trialEnd: row.trial_end,
    cancelAt: row.cancel_at,
    canceledAt: row.canceled_at,
    note: row.note,
  };
}

const OPEN_STRIPE = `SELECT 1 AS yes FROM subscriptions WHERE company_id = ? AND provider = 'stripe'
  AND status IN (${OPEN_STRIPE_STATUSES.map((s) => `'${s}'`).join(", ")}) LIMIT 1`;

/**
 * Усе, що показує сторінка оплати, шістьма читаннями одним пакетом.
 * `userId`: людина, що дивиться або платить (для пробного раз на людину).
 */
export async function loadBillingState(
  db: D1Database,
  companyId: string,
  opts: { userId?: string | null } = {},
): Promise<BillingState | null> {
  const [company, current, stripe, customer, trial, open] = await db.batch([
    db
      .prepare(
        `SELECT c.id, c.name, c.status, c.billing_email, a.access FROM companies c
           JOIN company_access a ON a.company_id = c.id WHERE c.id = ?`,
      )
      .bind(companyId),
    // Порядок як у CRM (crm/context.ts loadCompany): active, потім trialing, потім найдовший.
    db
      .prepare(
        `SELECT ${SUB_COLUMNS} FROM subscriptions s WHERE s.company_id = ? AND ${GRANTING}
          ORDER BY (s.status = 'active') DESC, (s.status = 'trialing') DESC, s.current_period_end DESC LIMIT 1`,
      )
      .bind(companyId),
    db
      .prepare(
        `SELECT ${SUB_COLUMNS} FROM subscriptions s WHERE s.company_id = ? AND s.provider = 'stripe'
          ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1`,
      )
      .bind(companyId),
    db
      .prepare(
        `SELECT stripe_customer_id FROM subscriptions WHERE company_id = ? AND stripe_customer_id IS NOT NULL
          ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .bind(companyId),
    db.prepare(HAD_TRIAL).bind(companyId, opts.userId ?? null),
    db.prepare(OPEN_STRIPE).bind(companyId),
  ]);

  const c = company.results[0] as
    | { id: string; name: string; status: string; billing_email: string | null; access: AccessMode }
    | undefined;
  if (!c) return null;
  const cur = current.results[0] as SubRow | undefined;
  const st = stripe.results[0] as SubRow | undefined;
  const cust = customer.results[0] as { stripe_customer_id: string } | undefined;

  return {
    companyId: c.id,
    companyName: c.name,
    companyStatus: c.status,
    billingEmail: c.billing_email,
    access: c.access,
    // Подання вже врахувало статус компанії; рядок підписки без доступу не показуємо як чинний.
    current: cur && c.access === "subscription" ? view(cur) : null,
    stripe: st ? { ...view(st), customerId: st.stripe_customer_id } : null,
    stripeOpen: open.results.length > 0,
    stripeCustomerId: cust?.stripe_customer_id ?? null,
    trialAvailable: trial.results.length === 0,
  };
}
