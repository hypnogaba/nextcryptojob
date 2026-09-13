import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-d1";
import { addCompany, addSubscription, all, crmDb, run } from "@/test/crm-fixtures";
import { hasAccess } from "./access";
import {
  checkoutCompleted,
  days,
  event,
  FakeStripe,
  invoiceEvent,
  signed,
  subscription,
  subscriptionEvent,
  unix,
  WEBHOOK_SECRET,
  webhookRequest,
} from "@/test/stripe-fixtures";
import type { Stripe } from "./stripe";
import { handleStripeEvent, stripeWebhookResponse, syncStripeSubscription } from "./webhook";

const SUB = "sub_1S9xQ2jTestSubscr01";
const CUS = "cus_T6aTestCustomer1";
const ENV = { STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_PRICE_ID: "price_x" };

type Row = {
  company_id: string;
  provider: string;
  status: string;
  current_period_start: string | null;
  current_period_end: string | null;
  trial_end: string | null;
  cancel_at: string | null;
  canceled_at: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string;
  stripe_price_id: string | null;
  currency: string | null;
  amount_cents: number | null;
};

let db: TestDb;
let fake: FakeStripe;
let company: string;

function stripeRows(): Row[] {
  return all<Row>(db.raw, "SELECT * FROM subscriptions WHERE provider = 'stripe' ORDER BY created_at");
}

function sql(d: Date): string {
  return new Date(unix(d) * 1000).toISOString().replace("T", " ").slice(0, 19);
}

async function post(evt: Stripe.Event, o: { secret?: string } = {}): Promise<Response> {
  const { body, signature } = await signed(evt, o);
  return stripeWebhookResponse(webhookRequest(body, signature), { db: db.d1, env: ENV, stripe: fake });
}

beforeEach(() => {
  db = crmDb();
  fake = new FakeStripe();
  company = addCompany(db.raw, { name: "Acme Labs" });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("webhook signature", () => {
  it("rejects a request without Stripe-Signature with 400 and writes nothing", async () => {
    fake.set(subscription({ companyId: company }));
    const { body } = await signed(subscriptionEvent("customer.subscription.created", subscription({ companyId: company })));
    const res = await stripeWebhookResponse(webhookRequest(body, null), { db: db.d1, env: ENV, stripe: fake });
    expect(res.status).toBe(400);
    expect(fake.retrieved).toEqual([]);
    expect(stripeRows()).toEqual([]);
  });

  it("rejects a signature made with another secret", async () => {
    fake.set(subscription({ companyId: company }));
    const res = await post(subscriptionEvent("customer.subscription.created", subscription({ companyId: company })), {
      secret: "whsec_someone_else",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid signature" });
    expect(stripeRows()).toEqual([]);
  });

  it("rejects a body changed after signing", async () => {
    const sub = subscription({ companyId: company });
    fake.set(sub);
    const { body, signature } = await signed(subscriptionEvent("customer.subscription.created", sub));
    const tampered = body.replace('"status":"active"', '"status":"canceled"');
    expect(tampered).not.toBe(body);
    const res = await stripeWebhookResponse(webhookRequest(tampered, signature), { db: db.d1, env: ENV, stripe: fake });
    expect(res.status).toBe(400);
    expect(stripeRows()).toEqual([]);
  });

  it("rejects a replayed event older than the 5 minute tolerance", async () => {
    fake.set(subscription({ companyId: company }));
    const evt = subscriptionEvent("customer.subscription.created", subscription({ companyId: company }));
    const { body, signature } = await signed(evt, { timestamp: unix(new Date()) - 3600 });
    const res = await stripeWebhookResponse(webhookRequest(body, signature), { db: db.d1, env: ENV, stripe: fake });
    expect(res.status).toBe(400);
    expect(stripeRows()).toEqual([]);
  });

  it("answers 503 and names what is missing when Stripe is not configured", async () => {
    const { body, signature } = await signed(event("customer.subscription.created", {}));
    const noSecret = await stripeWebhookResponse(webhookRequest(body, signature), {
      db: db.d1,
      env: { STRIPE_SECRET_KEY: "sk_test_fake" },
    });
    expect(noSecret.status).toBe(503);
    expect(await noSecret.json()).toEqual({ error: "not configured: STRIPE_WEBHOOK_SECRET" });

    const nothing = await stripeWebhookResponse(webhookRequest(body, signature), { db: db.d1, env: {} });
    expect(await nothing.json()).toEqual({ error: "not configured: STRIPE_WEBHOOK_SECRET, STRIPE_SECRET_KEY" });
  });

  it("accepts a correctly signed event and answers 200", async () => {
    const sub = subscription({ companyId: company, status: "trialing", trialEnd: days(14) });
    fake.set(sub);
    const res = await post(subscriptionEvent("customer.subscription.created", sub));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, outcome: "synced" });
    expect(stripeRows()).toHaveLength(1);
  });

  it("answers 200 without calling Stripe for events that are not about a subscription", async () => {
    const res = await post(event("charge.succeeded", { id: "ch_1", object: "charge" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, outcome: "ignored" });
    expect(fake.retrieved).toEqual([]);
  });
});

describe("events in any order", () => {
  const start = days(-3);
  const trialEnd = days(11);
  const periodEnd = days(27);

  /** Кінцевий стан у Stripe: пробний закінчився, перший рахунок сплачено. */
  function finalState(): Stripe.Subscription {
    return subscription({
      id: SUB,
      customer: CUS,
      companyId: company,
      status: "active",
      periodStart: start,
      periodEnd,
      trialStart: start,
      trialEnd,
    });
  }

  function lifecycle(): Stripe.Event[] {
    const trialing = subscription({ id: SUB, customer: CUS, companyId: company, status: "trialing", periodStart: start, periodEnd: trialEnd, trialEnd });
    return [
      checkoutCompleted({ subscriptionId: SUB, customer: CUS, companyId: company }),
      subscriptionEvent("customer.subscription.created", trialing),
      invoiceEvent("invoice.paid", { subscriptionId: SUB, customer: CUS, companyId: company }),
      subscriptionEvent("customer.subscription.trial_will_end", trialing),
      subscriptionEvent("customer.subscription.updated", finalState()),
    ];
  }

  function permutations<T>(items: T[]): T[][] {
    if (items.length <= 1) return [items];
    return items.flatMap((item, i) =>
      permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
    );
  }

  const EXPECTED = () => ({
    company_id: company,
    provider: "stripe",
    status: "active",
    current_period_start: sql(start),
    current_period_end: sql(periodEnd),
    trial_end: sql(trialEnd),
    cancel_at: null,
    canceled_at: null,
    stripe_customer_id: CUS,
    stripe_subscription_id: SUB,
    stripe_price_id: "price_1S9xNcjTestMonthly",
    currency: "usd",
    amount_cents: 10000,
  });

  it("every order of the five lifecycle events gives the same final row", async () => {
    const orders = permutations(lifecycle());
    expect(orders).toHaveLength(120);
    for (const order of orders) {
      db = crmDb();
      addCompany(db.raw, { id: company });
      fake = new FakeStripe().set(finalState());
      for (const evt of order) expect((await post(evt)).status).toBe(200);
      expect(stripeRows()).toEqual([expect.objectContaining(EXPECTED())]);
    }
    // 120 свіжих баз з усіма міграціями: сам тест ~2,5 с, а під навантаженням повного прогону буває понад 5 с.
  }, 30_000);

  it("duplicates of every event still leave exactly one correct row", async () => {
    fake.set(finalState());
    const events = lifecycle();
    for (const evt of [...events, ...events.reverse(), events[2], events[2]]) {
      expect((await post(evt)).status).toBe(200);
    }
    expect(stripeRows()).toEqual([expect.objectContaining(EXPECTED())]);
  });

  it("an old event that arrives late writes the current state, not its own payload", async () => {
    const created = subscriptionEvent(
      "customer.subscription.created",
      subscription({ id: SUB, customer: CUS, companyId: company, status: "trialing", trialEnd }),
    );
    fake.set(
      subscription({ id: SUB, customer: CUS, companyId: company, status: "canceled", periodStart: start, periodEnd, trialEnd, canceledAt: days(-1) }),
    );
    await post(subscriptionEvent("customer.subscription.deleted", fake.state.get(SUB)!));
    await post(created);
    const [row] = stripeRows();
    expect(row.status).toBe("canceled");
    expect(row.canceled_at).toBe(sql(days(-1)));
    expect(await hasAccess(db.d1, company)).toBe(false);
  });

  it("finds the subscription of an invoice event through parent.subscription_details", async () => {
    fake.set(subscription({ id: SUB, customer: CUS, companyId: company, status: "past_due" }));
    await post(invoiceEvent("invoice.payment_failed", { subscriptionId: SUB, customer: CUS, companyId: company }));
    expect(fake.retrieved).toEqual([SUB]);
    expect(stripeRows()[0].status).toBe("past_due");
  });

  it("ignores an invoice that does not belong to a subscription", async () => {
    const res = await post(invoiceEvent("invoice.paid", { subscriptionId: null, customer: CUS }));
    expect(res.status).toBe(200);
    expect(fake.retrieved).toEqual([]);
  });
});

describe("syncStripeSubscription", () => {
  it("a slower, older read does not overwrite a newer one", async () => {
    const t1 = new Date("2026-09-12T10:00:00Z");
    const t2 = new Date("2026-09-12T10:00:05Z");
    fake.set(subscription({ id: SUB, companyId: company, status: "canceled", canceledAt: days(-1) }));
    await syncStripeSubscription({ db: db.d1, stripe: fake, now: () => t2 }, SUB);

    fake.set(subscription({ id: SUB, companyId: company, status: "active" }));
    const late = await syncStripeSubscription({ db: db.d1, stripe: fake, now: () => t1 }, SUB);
    expect(late).toEqual({ outcome: "stale", subscriptionId: SUB });
    expect(stripeRows()[0].status).toBe("canceled");
  });

  it("keeps the company of an existing row even if metadata says otherwise", async () => {
    const other = addCompany(db.raw, { name: "Other" });
    fake.set(subscription({ id: SUB, companyId: company }));
    await syncStripeSubscription({ db: db.d1, stripe: fake }, SUB);
    fake.set(subscription({ id: SUB, companyId: other }));
    await syncStripeSubscription({ db: db.d1, stripe: fake }, SUB);
    expect(stripeRows().map((r) => r.company_id)).toEqual([company]);
  });

  it("uses client_reference_id from Checkout when the subscription has no metadata", async () => {
    fake.set(subscription({ id: SUB, companyId: null }));
    const res = await handleStripeEvent(
      { db: db.d1, stripe: fake },
      checkoutCompleted({ subscriptionId: SUB, customer: CUS, companyId: company }),
    );
    expect(res).toMatchObject({ outcome: "synced", companyId: company });
  });

  it("ignores a subscription of an unknown company instead of failing forever", async () => {
    fake.set(subscription({ id: SUB, companyId: "co_AAAAAAAAAAAAAAAAAAAA" }));
    expect(await syncStripeSubscription({ db: db.d1, stripe: fake }, SUB)).toEqual({
      outcome: "ignored",
      reason: "unknown company",
    });
    expect(stripeRows()).toEqual([]);
  });

  it("ignores a subscription Stripe no longer has, and the webhook still answers 200", async () => {
    const res = await post(subscriptionEvent("customer.subscription.updated", subscription({ id: "sub_gone", companyId: company })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, outcome: "ignored" });
  });

  it("answers 500 when Stripe cannot be reached, so Stripe retries the event", async () => {
    fake.set(subscription({ id: SUB, companyId: company }));
    fake.failNext = new Error("fetch failed");
    const res = await post(subscriptionEvent("customer.subscription.updated", subscription({ id: SUB, companyId: company })));
    expect(res.status).toBe(500);
    expect(stripeRows()).toEqual([]);
    // Повтор тієї самої події проходить.
    expect((await post(subscriptionEvent("customer.subscription.updated", subscription({ id: SUB, companyId: company })))).status).toBe(200);
    expect(stripeRows()).toHaveLength(1);
  });

  it("stores the EUR amount: asks Stripe to expand the price currency options", async () => {
    fake.set(subscription({ id: SUB, companyId: company, currency: "eur" }));
    await syncStripeSubscription({ db: db.d1, stripe: fake }, SUB);
    expect(fake.retrieveParams).toEqual([{ expand: ["items.data.price.currency_options"] }]);
    expect(stripeRows()[0]).toMatchObject({ currency: "eur", amount_cents: 9500 });
  });

  it("still syncs if Stripe refuses the expand: the row is right, only the EUR amount is unknown", async () => {
    fake.rejectExpand = true;
    fake.set(subscription({ id: SUB, companyId: company, currency: "eur", status: "active" }));
    const res = await syncStripeSubscription({ db: db.d1, stripe: fake }, SUB);
    expect(res).toMatchObject({ outcome: "synced", status: "active" });
    expect(fake.retrieveParams).toEqual([{ expand: ["items.data.price.currency_options"] }, {}]);
    expect(stripeRows()[0]).toMatchObject({ status: "active", currency: "eur", amount_cents: null });
  });

  it("does not touch manual or USDC rows of the same company", async () => {
    addSubscription(db.raw, company, { provider: "manual", status: "active" });
    fake.set(subscription({ id: SUB, companyId: company, status: "canceled", canceledAt: days(-1) }));
    await syncStripeSubscription({ db: db.d1, stripe: fake }, SUB);
    const rows = all<{ provider: string; status: string }>(db.raw, "SELECT provider, status FROM subscriptions ORDER BY provider");
    expect(rows).toEqual([
      { provider: "manual", status: "active" },
      { provider: "stripe", status: "canceled" },
    ]);
    expect(await hasAccess(db.d1, company)).toBe(true);
  });
});

describe("a second subscription for the same company", () => {
  it("is canceled through the API when another one is still open, and logged for a refund", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.set(subscription({ id: "sub_first", customer: CUS, companyId: company, status: "active" }));
    await syncStripeSubscription({ db: db.d1, stripe: fake }, "sub_first");

    // Друга вкладка Checkout теж дійшла до кінця.
    fake.set(subscription({ id: "sub_second", customer: "cus_second", companyId: company, status: "active" }));
    const res = await handleStripeEvent(
      { db: db.d1, stripe: fake },
      checkoutCompleted({ subscriptionId: "sub_second", customer: "cus_second", companyId: company }),
    );

    expect(fake.canceled).toEqual(["sub_second"]);
    expect(res).toMatchObject({ outcome: "synced", status: "canceled" });
    expect(
      all(db.raw, "SELECT stripe_subscription_id AS id, status FROM subscriptions ORDER BY stripe_subscription_id"),
    ).toEqual([
      { id: "sub_first", status: "active" },
      { id: "sub_second", status: "canceled" },
    ]);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/duplicate.*sub_second.*sub_first.*refund/i));
    expect(await hasAccess(db.d1, company)).toBe(true);
  });

  it("is kept when the earlier one has ended", async () => {
    fake.set(subscription({ id: "sub_first", companyId: company, status: "canceled", canceledAt: days(-5) }));
    await syncStripeSubscription({ db: db.d1, stripe: fake }, "sub_first");
    fake.set(subscription({ id: "sub_second", companyId: company, status: "active" }));
    await syncStripeSubscription({ db: db.d1, stripe: fake }, "sub_second");
    expect(fake.canceled).toEqual([]);
    expect(stripeRows().map((r) => r.status)).toEqual(["canceled", "active"]);
  });

  it("the first subscription is never canceled by later events", async () => {
    fake.set(subscription({ id: "sub_first", companyId: company, status: "active" }));
    await syncStripeSubscription({ db: db.d1, stripe: fake }, "sub_first");
    fake.set(subscription({ id: "sub_second", companyId: company, status: "active" }));
    await syncStripeSubscription({ db: db.d1, stripe: fake }, "sub_second");
    await syncStripeSubscription({ db: db.d1, stripe: fake }, "sub_first");
    await syncStripeSubscription({ db: db.d1, stripe: fake }, "sub_second");
    expect(fake.canceled).toEqual(["sub_second"]);
    expect(all(db.raw, "SELECT status FROM subscriptions ORDER BY stripe_subscription_id")).toEqual([
      { status: "active" },
      { status: "canceled" },
    ]);
  });
});

describe("a subscription of a closed company", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    run(db.raw, "UPDATE companies SET status = 'closed' WHERE id = ?", company);
  });

  it("is canceled through the API when it arrives after the close", async () => {
    // Checkout дійшов до кінця вже після закриття компанії.
    fake.set(subscription({ id: "sub_late", companyId: company, status: "active" }));
    const res = await syncStripeSubscription({ db: db.d1, stripe: fake }, "sub_late");
    expect(fake.canceled).toEqual(["sub_late"]);
    expect(res).toMatchObject({ outcome: "synced", status: "canceled" });
    expect(stripeRows().map((r) => r.status)).toEqual(["canceled"]);
    expect(await hasAccess(db.d1, company)).toBe(false);
  });

  it("is canceled when it becomes active later (3-D Secure confirmed after the close)", async () => {
    fake.set(subscription({ id: "sub_3ds", companyId: company, status: "incomplete" }));
    await syncStripeSubscription({ db: db.d1, stripe: fake }, "sub_3ds");
    expect(fake.canceled).toEqual(["sub_3ds"]);
    fake.set(subscription({ id: "sub_3ds", companyId: company, status: "active" }));
    await syncStripeSubscription({ db: db.d1, stripe: fake }, "sub_3ds");
    expect(fake.canceled).toEqual(["sub_3ds", "sub_3ds"]);
    expect(stripeRows().map((r) => r.status)).toEqual(["canceled"]);
  });

  it("an already canceled one is only recorded", async () => {
    fake.set(subscription({ id: "sub_done", companyId: company, status: "canceled", canceledAt: days(-1) }));
    await syncStripeSubscription({ db: db.d1, stripe: fake }, "sub_done");
    expect(fake.canceled).toEqual([]);
    expect(stripeRows().map((r) => r.status)).toEqual(["canceled"]);
  });
});
