import { newId } from "@/lib/ids";
import { sqlTime } from "@/lib/time";
import { Stripe, stripeClient, type StripeApi, type StripeEnv } from "./stripe";

/**
 * Вебхук Stripe (специфікація CRM, розділ 8).
 *
 * Правило одне: подія лише каже, ЯКА підписка змінилась. Стан беремо не з
 * тіла події, а з `stripe.subscriptions.retrieve(id)` і перезаписуємо рядок
 * `subscriptions` цілком. Тоді порядок подій і дублікати не мають значення:
 * стара подія, що прийшла пізно, все одно пише теперішній стан.
 *
 * Періоди з версії basil лежать на елементі підписки (`items.data[0]`),
 * а не на самій підписці.
 */

/** Події, на які підписано кінцеву точку в Stripe (решту приймаємо і пропускаємо). */
export const STRIPE_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.trial_will_end",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "invoice.finalization_failed",
] as const;

const HANDLED = new Set<string>(STRIPE_EVENTS);

/** Статуси з CHECK колонки subscriptions.status (0004). */
const STATUSES = new Set([
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "paused",
  "canceled",
]);

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

/** Id підписки Stripe, якої стосується подія; null, якщо подія не про підписку. */
export function subscriptionIdFromEvent(event: Stripe.Event): string | null {
  if (!HANDLED.has(event.type)) return null;
  const object = event.data.object as unknown as Record<string, unknown>;
  if (event.type === "checkout.session.completed") {
    const session = object as unknown as Stripe.Checkout.Session;
    return session.mode === "subscription" ? idOf(session.subscription) : null;
  }
  if (event.type.startsWith("customer.subscription.")) {
    return idOf(object as unknown as Stripe.Subscription);
  }
  if (event.type.startsWith("invoice.")) {
    const invoice = object as unknown as Stripe.Invoice;
    return idOf(invoice.parent?.subscription_details?.subscription ?? null);
  }
  return null;
}

/** Компанія, яку назвав Checkout (`client_reference_id`), якщо подія з Checkout. */
function companyHintFromEvent(event: Stripe.Event): string | null {
  if (event.type !== "checkout.session.completed") return null;
  return (event.data.object as Stripe.Checkout.Session).client_reference_id ?? null;
}

function unixToSql(seconds: number | null | undefined): string | null {
  return typeof seconds === "number" ? sqlTime(new Date(seconds * 1000)) : null;
}

export type SyncResult =
  | { outcome: "synced"; subscriptionId: string; companyId: string; status: string }
  | { outcome: "stale"; subscriptionId: string }
  | { outcome: "ignored"; reason: string };

export interface SyncDeps {
  db: D1Database;
  stripe: Pick<StripeApi, "subscriptions">;
  /** Мить перед запитом до Stripe; за замовчуванням зараз. */
  now?: () => Date;
}

function isMissingResource(err: unknown): boolean {
  return (
    err instanceof Stripe.errors.StripeError &&
    (err.code === "resource_missing" || err.statusCode === 404)
  );
}

/**
 * Перечитує підписку в Stripe і перезаписує її рядок.
 *
 * Компанія: рядок, що вже є (підписку ніколи не переносимо між компаніями),
 * інакше `metadata.company_id` (його ставить Checkout), інакше підказка з
 * `client_reference_id`. Невідома компанія або підписка → `ignored`: повтор
 * від Stripe цього не виправить.
 *
 * Два обробники можуть перечитати ту саму підписку одночасно. Рядок пише той,
 * хто почав перечитувати не раніше за попереднього (`stripe_synced_at`), тож
 * запізнілий старий стан не затирає новіший (з точністю до секунди).
 */
export async function syncStripeSubscription(
  deps: SyncDeps,
  stripeSubscriptionId: string,
  hint: { companyId?: string | null } = {},
): Promise<SyncResult> {
  const syncedAt = sqlTime((deps.now ?? (() => new Date()))());

  let sub: Stripe.Subscription;
  try {
    sub = await deps.stripe.subscriptions.retrieve(stripeSubscriptionId);
  } catch (err) {
    if (isMissingResource(err)) return { outcome: "ignored", reason: "subscription not found in Stripe" };
    throw err;
  }

  if (!STATUSES.has(sub.status)) {
    // Новий статус, якого ще немає в CHECK: краще знати, ніж тихо зберегти хибне.
    console.error(`stripe: unknown subscription status ${JSON.stringify(sub.status)} for ${sub.id}`);
    return { outcome: "ignored", reason: `unknown status ${sub.status}` };
  }

  const existing = await deps.db
    .prepare("SELECT company_id FROM subscriptions WHERE stripe_subscription_id = ?")
    .bind(sub.id)
    .first<{ company_id: string }>();
  const candidate = existing?.company_id ?? sub.metadata?.company_id ?? hint.companyId ?? null;
  if (!candidate) return { outcome: "ignored", reason: "no company_id on subscription" };
  const company = await deps.db
    .prepare("SELECT id FROM companies WHERE id = ?")
    .bind(candidate)
    .first<{ id: string }>();
  if (!company) return { outcome: "ignored", reason: "unknown company" };

  const item = sub.items?.data?.[0];
  const price = item?.price;
  const currency = sub.currency?.toLowerCase() ?? null;
  const amount =
    price && currency
      ? price.currency === currency
        ? price.unit_amount
        : (price.currency_options?.[currency]?.unit_amount ?? null)
      : null;

  const result = await deps.db
    .prepare(
      `INSERT INTO subscriptions (id, company_id, provider, plan, status, current_period_start, current_period_end,
                                  trial_end, cancel_at, canceled_at, stripe_customer_id, stripe_subscription_id,
                                  stripe_price_id, currency, amount_cents, stripe_synced_at, updated_at)
       VALUES (?, ?, 'stripe', 'company_monthly', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(stripe_subscription_id) DO UPDATE SET
         status               = excluded.status,
         current_period_start = excluded.current_period_start,
         current_period_end   = excluded.current_period_end,
         trial_end            = excluded.trial_end,
         cancel_at            = excluded.cancel_at,
         canceled_at          = excluded.canceled_at,
         stripe_customer_id   = excluded.stripe_customer_id,
         stripe_price_id      = excluded.stripe_price_id,
         currency             = excluded.currency,
         amount_cents         = excluded.amount_cents,
         stripe_synced_at     = excluded.stripe_synced_at,
         updated_at           = excluded.updated_at
       WHERE subscriptions.stripe_synced_at IS NULL
          OR excluded.stripe_synced_at >= subscriptions.stripe_synced_at`,
    )
    .bind(
      newId("sub"),
      company.id,
      sub.status,
      unixToSql(item?.current_period_start),
      unixToSql(item?.current_period_end),
      unixToSql(sub.trial_end),
      unixToSql(sub.cancel_at),
      unixToSql(sub.canceled_at),
      idOf(sub.customer),
      sub.id,
      price?.id ?? null,
      currency,
      amount ?? null,
      syncedAt,
      syncedAt,
    )
    .run();

  if (result.meta.changes === 0) return { outcome: "stale", subscriptionId: sub.id };
  return { outcome: "synced", subscriptionId: sub.id, companyId: company.id, status: sub.status };
}

/** Обробка перевіреної події. Не про підписку → `ignored` без запиту до Stripe. */
export async function handleStripeEvent(deps: SyncDeps, event: Stripe.Event): Promise<SyncResult> {
  const id = subscriptionIdFromEvent(event);
  if (!id) return { outcome: "ignored", reason: `not a subscription event: ${event.type}` };
  return syncStripeSubscription(deps, id, { companyId: companyHintFromEvent(event) });
}

/**
 * Перевірка підпису (`Stripe-Signature`) через WebCrypto. Кидає, якщо підпис
 * хибний, прострочений (типово 300 с) або тіло змінено.
 */
export async function verifyStripeEvent(body: string, signature: string, secret: string): Promise<Stripe.Event> {
  return Stripe.webhooks.constructEventAsync(body, signature, secret, undefined, Stripe.createSubtleCryptoProvider());
}

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export interface WebhookDeps {
  db: D1Database;
  env: StripeEnv;
  /** Замінник клієнта для тестів; інакше клієнт з STRIPE_SECRET_KEY. */
  stripe?: Pick<StripeApi, "subscriptions">;
  now?: () => Date;
}

/**
 * Відповідь маршруту /api/stripe/webhook.
 * - 503 `not configured: …`, якщо бракує STRIPE_WEBHOOK_SECRET або STRIPE_SECRET_KEY;
 * - 400 на відсутній чи хибний підпис (Stripe не повторює 4xx, і не треба);
 * - 200 одразу для подій не про підписку; для решти після одного retrieve і запису;
 * - 500 на збій Stripe чи D1: Stripe повторить подію (до 3 діб), а перезапис ідемпотентний.
 */
export async function stripeWebhookResponse(request: Request, deps: WebhookDeps): Promise<Response> {
  const secret = deps.env.STRIPE_WEBHOOK_SECRET?.trim();
  const stripe = deps.stripe ?? stripeClient(deps.env);
  if (!secret || !stripe) {
    const missing = [!secret && "STRIPE_WEBHOOK_SECRET", !stripe && "STRIPE_SECRET_KEY"].filter(Boolean).join(", ");
    return json(503, { error: `not configured: ${missing}` });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) return json(400, { error: "missing Stripe-Signature header" });

  // Сире тіло: підпис рахується від байтів, а не від розібраного JSON.
  const body = await request.text();
  let event: Stripe.Event;
  try {
    event = await verifyStripeEvent(body, signature, secret);
  } catch {
    return json(400, { error: "invalid signature" });
  }

  try {
    const result = await handleStripeEvent({ db: deps.db, stripe, now: deps.now }, event);
    if (result.outcome === "ignored" && HANDLED.has(event.type)) {
      console.warn(`stripe webhook ${event.id} (${event.type}) ignored: ${result.reason}`);
    }
    return json(200, { received: true, outcome: result.outcome });
  } catch (err) {
    console.error(`stripe webhook ${event.id} (${event.type}) failed:`, err instanceof Error ? err.message : String(err));
    return json(500, { error: "processing failed, retry later" });
  }
}
