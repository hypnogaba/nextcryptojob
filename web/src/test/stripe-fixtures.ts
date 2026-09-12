import { Stripe, type StripeApi } from "@/lib/billing/stripe";

/**
 * Замінник Stripe для тестів: об'єкти тієї самої форми, що віддає API
 * `2026-08-26.dahlia` (записано з відповідей режиму test і довідника API,
 * зайві для нас поля скорочено, але ті, що читає код, на своїх місцях:
 * періоди на `items.data[0]`, підписка інвойсу в `parent.subscription_details`).
 * Лише Node, у Worker не імпортувати.
 */

export const WEBHOOK_SECRET = "whsec_test_0123456789abcdefghijklmnopqrstuv";
export const PRICE_ID = "price_1S9xNcjTestMonthly";

export const unix = (d: Date) => Math.floor(d.getTime() / 1000);
export const days = (n: number, from = new Date()) => new Date(from.getTime() + n * 86_400_000);

export interface SubOpts {
  id?: string;
  customer?: string;
  companyId?: string | null;
  status?: Stripe.Subscription.Status;
  periodStart?: Date;
  periodEnd?: Date;
  trialStart?: Date | null;
  trialEnd?: Date | null;
  cancelAt?: Date | null;
  canceledAt?: Date | null;
  currency?: "usd" | "eur";
}

/** Підписка у формі відповіді `GET /v1/subscriptions/:id`. */
export function subscription(o: SubOpts = {}): Stripe.Subscription {
  const id = o.id ?? "sub_1S9xQ2jTestSubscr01";
  const customer = o.customer ?? "cus_T6aTestCustomer1";
  const start = o.periodStart ?? new Date();
  const end = o.periodEnd ?? days(30, start);
  const currency = o.currency ?? "usd";
  const created = unix(start) - 60;
  return {
    id,
    object: "subscription",
    application: null,
    application_fee_percent: null,
    automatic_tax: { disabled_reason: null, enabled: true, liability: { type: "self" } },
    billing_cycle_anchor: unix(end),
    billing_cycle_anchor_config: null,
    billing_mode: { flexible: { proration_discounts: "included" }, type: "flexible", updated_at: created },
    billing_thresholds: null,
    cancel_at: o.cancelAt ? unix(o.cancelAt) : null,
    cancel_at_period_end: Boolean(o.cancelAt),
    canceled_at: o.canceledAt ? unix(o.canceledAt) : null,
    cancellation_details: { comment: null, feedback: null, reason: o.canceledAt ? "cancellation_requested" : null },
    collection_method: "charge_automatically",
    created,
    currency,
    customer,
    days_until_due: null,
    default_payment_method: "pm_1S9xQ0jTestCard0001",
    default_source: null,
    default_tax_rates: [],
    description: null,
    discounts: [],
    ended_at: o.status === "canceled" ? unix(o.canceledAt ?? end) : null,
    invoice_settings: { account_tax_ids: null, issuer: { type: "self" } },
    items: {
      object: "list",
      data: [
        {
          id: "si_T6aTestItem0001",
          object: "subscription_item",
          billing_thresholds: null,
          created,
          current_period_end: unix(end),
          current_period_start: unix(start),
          discounts: [],
          metadata: {},
          price: {
            id: PRICE_ID,
            object: "price",
            active: true,
            billing_scheme: "per_unit",
            created: 1757600000,
            currency: "usd",
            // Справжній API віддає лише з expand; FakeStripe прибирає без нього.
            currency_options: {
              usd: { custom_unit_amount: null, tax_behavior: "exclusive", unit_amount: 10000, unit_amount_decimal: "10000" },
              eur: { custom_unit_amount: null, tax_behavior: "exclusive", unit_amount: 9500, unit_amount_decimal: "9500" },
            },
            livemode: false,
            lookup_key: "company_monthly",
            metadata: {},
            nickname: null,
            product: "prod_T6aTestCompany",
            recurring: { interval: "month", interval_count: 1, meter: null, trial_period_days: null, usage_type: "licensed" },
            tax_behavior: "exclusive",
            tiers_mode: null,
            transform_quantity: null,
            type: "recurring",
            unit_amount: 10000,
            unit_amount_decimal: "10000",
          },
          quantity: 1,
          subscription: id,
          tax_rates: [],
        },
      ],
      has_more: false,
      url: `/v1/subscription_items?subscription=${id}`,
    },
    latest_invoice: "in_1S9xQ3jTestInvoice1",
    livemode: false,
    metadata: o.companyId === null ? {} : { company_id: o.companyId ?? "co_missing" },
    next_pending_invoice_item_invoice: null,
    on_behalf_of: null,
    pause_collection: null,
    payment_settings: { payment_method_options: null, payment_method_types: null, save_default_payment_method: "off" },
    pending_invoice_item_interval: null,
    pending_setup_intent: null,
    pending_update: null,
    schedule: null,
    start_date: created,
    status: o.status ?? "active",
    test_clock: null,
    transfer_data: null,
    trial_end: o.trialEnd ? unix(o.trialEnd) : null,
    trial_settings: { end_behavior: { missing_payment_method: "create_invoice" } },
    trial_start: o.trialStart ? unix(o.trialStart) : o.trialEnd ? created : null,
  } as unknown as Stripe.Subscription;
}

let seq = 0;

/** Подія у формі тіла вебхука. */
export function event(type: string, object: Record<string, unknown>): Stripe.Event {
  seq += 1;
  return {
    id: `evt_1S9xTest${String(seq).padStart(8, "0")}`,
    object: "event",
    api_version: "2026-08-26.dahlia",
    created: unix(new Date()),
    data: { object },
    livemode: false,
    pending_webhooks: 1,
    request: { id: `req_Test${seq}`, idempotency_key: null },
    type,
  } as unknown as Stripe.Event;
}

export function checkoutCompleted(o: { subscriptionId: string; customer: string; companyId: string }): Stripe.Event {
  return event("checkout.session.completed", {
    id: "cs_test_a1B2c3D4e5F6g7H8i9J0",
    object: "checkout.session",
    automatic_tax: { enabled: true, liability: { type: "self" }, status: "complete" },
    billing_address_collection: "required",
    cancel_url: "https://nextcryptojob.xyz/company/billing?checkout=canceled",
    client_reference_id: o.companyId,
    created: unix(new Date()),
    currency: "usd",
    customer: o.customer,
    customer_details: { address: { country: "FR" }, email: "dana@acme.io", name: "Acme Labs", tax_exempt: "none", tax_ids: [] },
    customer_email: "dana@acme.io",
    invoice: "in_1S9xQ3jTestInvoice1",
    livemode: false,
    metadata: { company_id: o.companyId },
    mode: "subscription",
    payment_method_collection: "always",
    payment_status: "no_payment_required",
    status: "complete",
    subscription: o.subscriptionId,
    success_url: "https://nextcryptojob.xyz/company/billing?checkout=success",
    tax_id_collection: { enabled: true, required: "never" },
    total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
  });
}

export function subscriptionEvent(type: string, sub: Stripe.Subscription): Stripe.Event {
  return event(type, sub as unknown as Record<string, unknown>);
}

export function invoiceEvent(
  type: "invoice.paid" | "invoice.payment_failed" | "invoice.payment_action_required" | "invoice.finalization_failed",
  o: { subscriptionId: string | null; customer: string; companyId?: string },
): Stripe.Event {
  return event(type, {
    id: "in_1S9xQ3jTestInvoice1",
    object: "invoice",
    amount_due: 10000,
    amount_paid: type === "invoice.paid" ? 10000 : 0,
    amount_remaining: type === "invoice.paid" ? 0 : 10000,
    attempt_count: type === "invoice.paid" ? 1 : 2,
    billing_reason: "subscription_cycle",
    collection_method: "charge_automatically",
    currency: "usd",
    customer: o.customer,
    livemode: false,
    parent: o.subscriptionId
      ? {
          quote_details: null,
          subscription_details: { metadata: { company_id: o.companyId ?? "co_missing" }, subscription: o.subscriptionId },
          type: "subscription_details",
        }
      : null,
    status: type === "invoice.paid" ? "paid" : "open",
    total: 10000,
  });
}

/** Тіло й заголовок Stripe-Signature, як їх шле Stripe. */
export async function signed(
  evt: Stripe.Event,
  o: { secret?: string; timestamp?: number } = {},
): Promise<{ body: string; signature: string }> {
  const body = JSON.stringify(evt);
  const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
    payload: body,
    secret: o.secret ?? WEBHOOK_SECRET,
    timestamp: o.timestamp,
    cryptoProvider: Stripe.createSubtleCryptoProvider(),
  });
  return { body, signature };
}

export function webhookRequest(body: string, signature: string | null): Request {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  if (signature !== null) headers.set("stripe-signature", signature);
  return new Request("https://nextcryptojob.xyz/api/stripe/webhook", { method: "POST", headers, body });
}

/**
 * Stripe у пам'яті: `retrieve` віддає поточний стан підписки (копію), як
 * справжній API. Тест міняє стан через `set` і дивиться, що запишеться.
 */
export class FakeStripe implements StripeApi {
  readonly state = new Map<string, Stripe.Subscription>();
  readonly retrieved: string[] = [];
  readonly checkoutCalls: Stripe.Checkout.SessionCreateParams[] = [];
  readonly portalCalls: Stripe.BillingPortal.SessionCreateParams[] = [];
  /** Кинути цю помилку з наступного retrieve. */
  failNext: Error | null = null;
  /** Відкидати expand, як відкинув би Stripe шлях, якого не приймає. */
  rejectExpand = false;

  set(sub: Stripe.Subscription): this {
    this.state.set(sub.id, sub);
    return this;
  }

  /** Скасовані через API (дубль підписки). */
  readonly canceled: string[] = [];

  subscriptions = {
    retrieve: async (id: string, params?: Stripe.SubscriptionRetrieveParams): Promise<Stripe.Subscription> => {
      this.retrieved.push(id);
      this.retrieveParams.push(params ?? {});
      if (this.failNext) {
        const err = this.failNext;
        this.failNext = null;
        throw err;
      }
      if (this.rejectExpand && params?.expand?.length) {
        throw new Stripe.errors.StripeInvalidRequestError({
          type: "invalid_request_error",
          param: "expand[0]",
          statusCode: 400,
          message: `This property cannot be expanded (${params.expand[0]}).`,
        });
      }
      const sub = structuredClone(this.found(id));
      // Як справжній API: currency_options ціни приходить лише з expand.
      if (!params?.expand?.includes("items.data.price.currency_options")) {
        for (const item of sub.items.data) delete (item.price as { currency_options?: unknown }).currency_options;
      }
      return sub;
    },
    cancel: async (id: string): Promise<Stripe.Subscription> => {
      this.canceled.push(id);
      const sub = structuredClone(this.found(id));
      const now = unix(new Date());
      Object.assign(sub, { status: "canceled", canceled_at: now, ended_at: now });
      this.state.set(id, sub);
      return structuredClone(sub);
    },
  };

  readonly retrieveParams: Stripe.SubscriptionRetrieveParams[] = [];

  private found(id: string): Stripe.Subscription {
    const sub = this.state.get(id);
    if (!sub) {
      throw new Stripe.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        code: "resource_missing",
        statusCode: 404,
        message: `No such subscription: '${id}'`,
      });
    }
    return sub;
  }

  checkout = {
    sessions: {
      create: async (params: Stripe.Checkout.SessionCreateParams) => {
        this.checkoutCalls.push(params);
        return { id: `cs_test_${this.checkoutCalls.length}`, url: `https://checkout.stripe.com/c/pay/cs_test_${this.checkoutCalls.length}` };
      },
    },
  };

  billingPortal = {
    sessions: {
      create: async (params: Stripe.BillingPortal.SessionCreateParams) => {
        this.portalCalls.push(params);
        return { url: `https://billing.stripe.com/p/session/test_${this.portalCalls.length}` };
      },
    },
  };
}
