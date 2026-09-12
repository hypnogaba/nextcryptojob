import { loadBillingState } from "./access";
import type { Stripe, StripeApi } from "./stripe";

/**
 * Stripe Checkout для підписки компанії (специфікація CRM, розділ 8).
 *
 * Одна ціна (`STRIPE_PRICE_ID`, $100 на місяць з currency_options.eur, ціна без
 * податку), Stripe Tax сам рахує ПДВ, покупець може ввести VAT ID. Пробні
 * 14 днів лише раз на компанію і раз на людину: якщо компанія або її власник
 * уже мали пробний (Stripe чи ручний від адміна), кнопка стає "Subscribe" і
 * сесія йде без пробного.
 * Картку просимо завжди, навіть на пробний (питання 1 у специфікації, розділ 14).
 */

export const TRIAL_DAYS = 14;

/**
 * Сесія Checkout живе 30 хв (найменше, що дозволяє Stripe) плюс хвилина: Stripe
 * рахує від миті створення в себе, а запит іде якийсь час. Коротке життя
 * звужує вікно, коли дві відкриті вкладки дають дві підписки (другу все одно
 * скасує вебхук, див. webhook.ts).
 */
export const CHECKOUT_TTL_SECONDS = 31 * 60;

export interface CheckoutDeps {
  db: D1Database;
  stripe: Pick<StripeApi, "checkout">;
  priceId: string;
}

export interface CheckoutInput {
  companyId: string;
  /** Пошта власника: Stripe створить клієнта з нею, якщо клієнта ще немає. */
  email: string | null;
  /** Людина, що платить: пробний раз на людину (access.ts hadTrial). */
  userId: string | null;
  /** Походження сайту для адрес повернення, напр. https://nextcryptojob.xyz. */
  origin: string;
}

export type CheckoutResult =
  | { ok: true; url: string; trial: boolean }
  | { ok: false; reason: "not_found" | "company_not_active" | "already_subscribed" | "no_url" };

/** Параметри сесії. Окремо, щоб тест бачив рівно те, що піде в Stripe. */
export function checkoutParams(o: {
  companyId: string;
  priceId: string;
  origin: string;
  trial: boolean;
  customerId: string | null;
  email: string | null;
  now?: Date;
}): Stripe.Checkout.SessionCreateParams {
  const billing = `${o.origin}/company/billing`;
  return {
    expires_at: Math.floor((o.now ?? new Date()).getTime() / 1000) + CHECKOUT_TTL_SECONDS,
    mode: "subscription",
    line_items: [{ price: o.priceId, quantity: 1 }],
    client_reference_id: o.companyId,
    metadata: { company_id: o.companyId },
    subscription_data: {
      metadata: { company_id: o.companyId },
      ...(o.trial ? { trial_period_days: TRIAL_DAYS } : {}),
    },
    automatic_tax: { enabled: true },
    tax_id_collection: { enabled: true },
    billing_address_collection: "required",
    // Наявний клієнт: Checkout оновить його адресу й назву (без цього Stripe Tax
    // і збір VAT ID з наявним клієнтом не працюють). Новий: Stripe створить з поштою.
    ...(o.customerId
      ? { customer: o.customerId, customer_update: { address: "auto", name: "auto" } }
      : o.email
        ? { customer_email: o.email }
        : {}),
    payment_method_collection: "always",
    success_url: `${billing}?checkout=success`,
    cancel_url: `${billing}?checkout=canceled`,
  };
}

export async function createCheckout(deps: CheckoutDeps, input: CheckoutInput): Promise<CheckoutResult> {
  const state = await loadBillingState(deps.db, input.companyId, { userId: input.userId });
  if (!state) return { ok: false, reason: "not_found" };
  if (state.companyStatus !== "active") return { ok: false, reason: "company_not_active" };
  // Жива підписка Stripe уже є: друга дала б подвійне списання. Керувати нею можна в порталі.
  if (state.stripeOpen) return { ok: false, reason: "already_subscribed" };

  const trial = state.trialAvailable;
  const session = await deps.stripe.checkout.sessions.create(
    checkoutParams({
      companyId: state.companyId,
      priceId: deps.priceId,
      origin: input.origin,
      trial,
      customerId: state.stripeCustomerId,
      email: state.billingEmail ?? input.email,
    }),
  );
  if (!session.url) return { ok: false, reason: "no_url" };
  return { ok: true, url: session.url, trial };
}
