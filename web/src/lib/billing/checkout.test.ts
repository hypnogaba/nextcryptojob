import { beforeEach, describe, expect, it } from "vitest";
import type { TestDb } from "@/test/sqlite-d1";
import { addCompany, addMember, addSubscription, addUser, crmDb, run } from "@/test/crm-fixtures";
import { loadBillingState } from "./access";
import { createCheckout, TRIAL_DAYS } from "./checkout";
import { grantManualAccess } from "./manual";
import { createPortal } from "./portal";
import { days, FakeStripe, PRICE_ID, subscription } from "@/test/stripe-fixtures";
import { syncStripeSubscription } from "./webhook";

const ORIGIN = "https://nextcryptojob.xyz";
let db: TestDb;
let fake: FakeStripe;
let company: string;

function checkout(email: string | null = "dana@acme.io", userId: string | null = null) {
  return createCheckout(
    { db: db.d1, stripe: fake, priceId: PRICE_ID },
    { companyId: company, email, userId, origin: ORIGIN },
  );
}

/** Webhook записав підписку Stripe цієї компанії з таким станом. */
async function stripeSays(o: Parameters<typeof subscription>[0]) {
  const sub = subscription({ companyId: company, ...o });
  fake.set(sub);
  await syncStripeSubscription({ db: db.d1, stripe: fake }, sub.id);
}

beforeEach(() => {
  db = crmDb();
  fake = new FakeStripe();
  company = addCompany(db.raw);
});

describe("createCheckout", () => {
  it("creates a subscription session with tax, VAT ID, trial and the company attached", async () => {
    const before = Math.floor(Date.now() / 1000);
    const res = await checkout();
    expect(res).toEqual({ ok: true, url: "https://checkout.stripe.com/c/pay/cs_test_1", trial: true });
    // Сесія живе найменше, що дозволяє Stripe (30 хв після створення), плюс хвилина на дорогу запиту.
    const expiresAt = fake.checkoutCalls[0].expires_at!;
    expect(expiresAt - before).toBeGreaterThanOrEqual(30 * 60);
    expect(expiresAt - before).toBeLessThanOrEqual(32 * 60);
    expect(fake.checkoutCalls).toEqual([
      {
        expires_at: expiresAt,
        mode: "subscription",
        line_items: [{ price: PRICE_ID, quantity: 1 }],
        client_reference_id: company,
        metadata: { company_id: company },
        subscription_data: { metadata: { company_id: company }, trial_period_days: TRIAL_DAYS },
        automatic_tax: { enabled: true },
        tax_id_collection: { enabled: true },
        billing_address_collection: "required",
        customer_email: "dana@acme.io",
        payment_method_collection: "always",
        success_url: `${ORIGIN}/company/billing?checkout=success`,
        cancel_url: `${ORIGIN}/company/billing?checkout=canceled`,
      },
    ]);
  });

  it("gives the trial once per company: after a canceled trial the session has no trial", async () => {
    await stripeSays({ id: "sub_first", customer: "cus_acme", status: "canceled", trialEnd: days(-2), canceledAt: days(-2) });
    const res = await checkout();
    expect(res).toMatchObject({ ok: true, trial: false });
    const params = fake.checkoutCalls[0];
    expect(params.subscription_data).toEqual({ metadata: { company_id: company } });
    // Наявний клієнт Stripe: без нової пошти, Checkout оновлює адресу й назву (Stripe Tax, VAT ID).
    expect(params.customer).toBe("cus_acme");
    expect(params.customer_update).toEqual({ address: "auto", name: "auto" });
    expect(params.customer_email).toBeUndefined();
  });

  it("gives no Stripe trial after a manual trial from an admin", async () => {
    const admin = addUser(db.raw);
    await grantManualAccess(db.d1, { companyId: company, status: "trialing", periodEnd: days(5), note: "Partner access", adminUserId: admin });
    expect(await checkout()).toMatchObject({ ok: true, trial: false });
  });

  it("still offers the trial after a manual active grant", async () => {
    const admin = addUser(db.raw);
    await grantManualAccess(db.d1, { companyId: company, status: "active", periodEnd: days(5), note: "Partner", adminUserId: admin });
    expect(await checkout()).toMatchObject({ ok: true, trial: true });
  });

  it("uses the company billing email when it is set", async () => {
    run(db.raw, "UPDATE companies SET billing_email = 'billing@acme.io' WHERE id = ?", company);
    await checkout("dana@acme.io");
    expect(fake.checkoutCalls[0].customer_email).toBe("billing@acme.io");
  });

  it("refuses a second subscription while one is alive (trialing, active, past due)", async () => {
    for (const status of ["trialing", "active", "past_due"] as const) {
      await stripeSays({ id: `sub_${status}`, status, trialEnd: status === "trialing" ? days(10) : null });
      expect(await checkout()).toEqual({ ok: false, reason: "already_subscribed" });
      run(db.raw, "DELETE FROM subscriptions");
    }
    expect(fake.checkoutCalls).toEqual([]);
  });

  it("refuses while any Stripe subscription is open, even if a newer one has ended", async () => {
    await stripeSays({ id: "sub_open", status: "active" });
    run(db.raw, "UPDATE subscriptions SET created_at = datetime('now', '-40 days')");
    await stripeSays({ id: "sub_newer", status: "canceled", canceledAt: days(-1) });
    expect(await checkout()).toEqual({ ok: false, reason: "already_subscribed" });
  });

  it("refuses a company that is not active", async () => {
    run(db.raw, "UPDATE companies SET status = 'pending_review' WHERE id = ?", company);
    expect(await checkout()).toEqual({ ok: false, reason: "company_not_active" });
  });
});

describe("createPortal", () => {
  it("needs a Stripe customer", async () => {
    expect(await createPortal({ db: db.d1, stripe: fake }, { companyId: company, origin: ORIGIN })).toEqual({
      ok: false,
      reason: "no_customer",
    });
  });

  it("opens the portal for the company customer and returns to billing", async () => {
    await stripeSays({ id: "sub_live", customer: "cus_acme", status: "active" });
    const res = await createPortal({ db: db.d1, stripe: fake }, { companyId: company, origin: ORIGIN });
    expect(res).toEqual({ ok: true, url: "https://billing.stripe.com/p/session/test_1" });
    expect(fake.portalCalls).toEqual([{ customer: "cus_acme", return_url: `${ORIGIN}/company/billing` }]);
  });
});

describe("trial once per person", () => {
  it("an owner who used a trial in another company gets no trial in a new one", async () => {
    const dana = addUser(db.raw, { email: "dana@acme.io" });
    const old = addCompany(db.raw, { name: "Old Labs" });
    addMember(db.raw, old, dana, "owner");
    run(db.raw, `INSERT INTO subscriptions (id, company_id, provider, status, current_period_end, trial_end, stripe_subscription_id)
                 VALUES ('sub_AAAAAAAAAAAAAAAAAAAA', ?, 'stripe', 'canceled', datetime('now', '-60 days'), datetime('now', '-70 days'), 'sub_old')`, old);
    addMember(db.raw, company, dana, "owner");

    expect(await checkout("dana@acme.io", dana)).toMatchObject({ ok: true, trial: false });
    expect((await loadBillingState(db.d1, company, { userId: dana }))?.trialAvailable).toBe(false);
  });

  it("the creator of a company that had a trial counts too, even after leaving it", async () => {
    const dana = addUser(db.raw);
    const old = addCompany(db.raw, { name: "Old Labs" });
    run(db.raw, "UPDATE companies SET created_by = ? WHERE id = ?", dana, old);
    addSubscription(db.raw, old, { provider: "manual", status: "trialing" });
    expect(await checkout("dana@acme.io", dana)).toMatchObject({ ok: true, trial: false });
  });

  it("a plain member of a company that had a trial still gets one for their own company", async () => {
    const lee = addUser(db.raw);
    const other = addCompany(db.raw, { name: "Other" });
    addMember(db.raw, other, lee, "member");
    addSubscription(db.raw, other, { provider: "manual", status: "trialing" });
    expect(await checkout("lee@acme.io", lee)).toMatchObject({ ok: true, trial: true });
  });
});
