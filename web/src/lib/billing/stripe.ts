import Stripe from "stripe";

/**
 * Клієнт Stripe для Worker (специфікація CRM, розділ 8).
 *
 * `stripe@22` з API `2026-08-26.dahlia`. На Workers немає модуля `http` Node,
 * тому HTTP через fetch (`createFetchHttpClient`), а підпис вебхука через
 * WebCrypto (`createSubtleCryptoProvider`, у webhook.ts). v22 вимагає `new`.
 *
 * Без ключів (contracts §8) картка вимкнена, а код каже, чого бракує:
 * сторінка оплати показує "Card payments are coming soon", вебхук відповідає 503.
 */

export const STRIPE_API_VERSION = "2026-08-26.dahlia" as const satisfies Stripe.LatestApiVersion;

/** Змінні, які читає оплата карткою. Секрети Worker і звичайні змінні приходять однаково. */
export interface StripeEnv {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** Один Price: $100 на місяць з currency_options.eur, tax_behavior exclusive. */
  STRIPE_PRICE_ID?: string;
}

export type StripeSettings =
  | { enabled: true; secretKey: string; priceId: string; webhookSecret: string }
  | {
      enabled: false;
      /** Текст для журналу й адмінки, без секретів: "not configured: STRIPE_SECRET_KEY". */
      reason: string;
      missing: string[];
    };

function clean(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

/**
 * Чи можна продавати карткою. Потрібні всі три: ключ, ціна і секрет вебхука.
 * Без секрету вебхука Checkout узяв би гроші, а рядок підписки так і не
 * з'явився б у базі (доступу немає, хоч компанія заплатила). Тому без будь-якого
 * з трьох кнопки картки вимкнені, а причину видно в адмінці.
 */
export function stripeSettings(env: StripeEnv): StripeSettings {
  const secretKey = clean(env.STRIPE_SECRET_KEY);
  const priceId = clean(env.STRIPE_PRICE_ID);
  const webhookSecret = clean(env.STRIPE_WEBHOOK_SECRET);
  const missing: string[] = [];
  if (!secretKey) missing.push("STRIPE_SECRET_KEY");
  if (!priceId) missing.push("STRIPE_PRICE_ID");
  if (!webhookSecret) missing.push("STRIPE_WEBHOOK_SECRET");
  if (!secretKey || !priceId || !webhookSecret) {
    return { enabled: false, reason: `not configured: ${missing.join(", ")}`, missing };
  }
  return { enabled: true, secretKey, priceId, webhookSecret };
}

/** Клієнт Stripe або null, якщо немає STRIPE_SECRET_KEY. */
export function stripeClient(env: StripeEnv): Stripe | null {
  const key = clean(env.STRIPE_SECRET_KEY);
  if (!key) return null;
  return new Stripe(key, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
    // Вебхук і server action чекають на відповідь: довше 10 с краще впасти й повторити.
    timeout: 10_000,
    maxNetworkRetries: 1,
  });
}

/**
 * Частина клієнта, якою користується код оплати. Тести підставляють замінник
 * з тими самими формами відповідей, без мережі.
 */
export interface StripeApi {
  subscriptions: {
    retrieve(id: string, params?: Stripe.SubscriptionRetrieveParams): Promise<Stripe.Subscription>;
    cancel(id: string, params?: Stripe.SubscriptionCancelParams): Promise<Stripe.Subscription>;
  };
  checkout: {
    sessions: {
      create(params: Stripe.Checkout.SessionCreateParams): Promise<Pick<Stripe.Checkout.Session, "id" | "url">>;
    };
  };
  billingPortal: {
    sessions: {
      create(params: Stripe.BillingPortal.SessionCreateParams): Promise<Pick<Stripe.BillingPortal.Session, "url">>;
    };
  };
}

export { Stripe };
