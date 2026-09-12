import { beforeEach, describe, expect, it } from "vitest";
import type { TestDb } from "@/test/sqlite-d1";
import { addCompany, addSubscription, crmDb, run } from "@/test/crm-fixtures";
import { companyAccess, hadTrial, hasAccess, loadBillingState } from "./access";
import { days, FakeStripe, subscription } from "./stripe-fixtures";
import { syncStripeSubscription } from "./webhook";

let db: TestDb;

/** Час SQLite відносно зараз, як його пише код: datetime('now', '<shift>'). */
function at(shift: string): string {
  return (db.raw.prepare("SELECT datetime('now', ?) AS t").get(shift) as { t: string }).t;
}

beforeEach(() => {
  db = crmDb();
});

describe("company_access view", () => {
  const cases: {
    name: string;
    company?: string;
    subs: { provider: "stripe" | "usdc" | "manual"; status: string; end: string; start?: string }[];
    access: "subscription" | "pay_per_request" | "none";
  }[] = [
    { name: "no subscription at all", subs: [], access: "pay_per_request" },
    { name: "Stripe active", subs: [{ provider: "stripe", status: "active", end: "+20 days" }], access: "subscription" },
    { name: "Stripe trialing", subs: [{ provider: "stripe", status: "trialing", end: "+10 days" }], access: "subscription" },
    {
      name: "Stripe active, period ended 1 day ago (renewal webhook late, within 2 days)",
      subs: [{ provider: "stripe", status: "active", end: "-1 day" }],
      access: "subscription",
    },
    {
      name: "Stripe active, period ended 3 days ago (no renewal)",
      subs: [{ provider: "stripe", status: "active", end: "-3 days" }],
      access: "pay_per_request",
    },
    { name: "Stripe past_due, 5 days", subs: [{ provider: "stripe", status: "past_due", end: "-5 days" }], access: "subscription" },
    { name: "Stripe past_due, 8 days", subs: [{ provider: "stripe", status: "past_due", end: "-8 days" }], access: "pay_per_request" },
    { name: "Stripe canceled", subs: [{ provider: "stripe", status: "canceled", end: "+20 days" }], access: "pay_per_request" },
    { name: "Stripe unpaid", subs: [{ provider: "stripe", status: "unpaid", end: "+20 days" }], access: "pay_per_request" },
    { name: "manual trialing", subs: [{ provider: "manual", status: "trialing", end: "+7 days" }], access: "subscription" },
    { name: "manual active", subs: [{ provider: "manual", status: "active", end: "+60 days" }], access: "subscription" },
    {
      name: "manual expired an hour ago (no grace for manual)",
      subs: [{ provider: "manual", status: "active", end: "-1 hour" }],
      access: "pay_per_request",
    },
    { name: "USDC period running", subs: [{ provider: "usdc", status: "active", end: "+12 days" }], access: "subscription" },
    {
      name: "USDC next period bought ahead",
      subs: [
        { provider: "usdc", status: "active", end: "+2 days", start: "-28 days" },
        { provider: "usdc", status: "active", end: "+32 days", start: "+2 days" },
      ],
      access: "subscription",
    },
    { name: "USDC period over", subs: [{ provider: "usdc", status: "active", end: "-1 minute" }], access: "pay_per_request" },
    {
      name: "expired USDC but Stripe active",
      subs: [
        { provider: "usdc", status: "active", end: "-10 days" },
        { provider: "stripe", status: "active", end: "+10 days" },
      ],
      access: "subscription",
    },
    {
      name: "suspended company with a paid subscription",
      company: "suspended",
      subs: [{ provider: "stripe", status: "active", end: "+20 days" }],
      access: "none",
    },
    { name: "agency under review", company: "pending_review", subs: [], access: "none" },
  ];

  for (const c of cases) {
    it(`${c.name}: ${c.access}`, async () => {
      const co = addCompany(db.raw, { status: c.company ?? "active" });
      for (const s of c.subs) {
        addSubscription(db.raw, co, { provider: s.provider, status: s.status, end: at(s.end), start: s.start ? at(s.start) : undefined });
      }
      expect((await companyAccess(db.d1, co))?.access).toBe(c.access);
      expect(await hasAccess(db.d1, co)).toBe(c.access === "subscription");
      // Сторінка оплати бачить чинну підписку рівно тоді, коли подання каже "subscription".
      const state = await loadBillingState(db.d1, co);
      expect(state?.access).toBe(c.access);
      expect(state?.current !== null).toBe(c.access === "subscription");
    });
  }

  it("says nothing for a company that does not exist", async () => {
    expect(await companyAccess(db.d1, "co_AAAAAAAAAAAAAAAAAAAA")).toBeNull();
    expect(await hasAccess(db.d1, "co_AAAAAAAAAAAAAAAAAAAA")).toBe(false);
  });
});

describe("cancel at period end", () => {
  it("keeps access until the period ends, then not", async () => {
    const co = addCompany(db.raw);
    const fake = new FakeStripe();
    const sync = () => syncStripeSubscription({ db: db.d1, stripe: fake }, "sub_cancel");
    const periodEnd = days(9);

    // Власник скасував у порталі: Stripe лишає active з cancel_at = кінець періоду.
    fake.set(subscription({ id: "sub_cancel", companyId: co, status: "active", periodStart: days(-21), periodEnd, cancelAt: periodEnd }));
    await sync();
    expect(await hasAccess(db.d1, co)).toBe(true);
    const state = await loadBillingState(db.d1, co);
    expect(state?.current?.cancelAt).not.toBeNull();
    expect(state?.stripeOpen).toBe(true);

    // Кінець періоду: Stripe шле customer.subscription.deleted, retrieve дає canceled.
    fake.set(
      subscription({ id: "sub_cancel", companyId: co, status: "canceled", periodStart: days(-21), periodEnd, cancelAt: periodEnd, canceledAt: periodEnd }),
    );
    await sync();
    expect(await hasAccess(db.d1, co)).toBe(false);
    expect((await loadBillingState(db.d1, co))?.stripeOpen).toBe(false);
  });

  it("stops access 2 days after the period end even if the final webhook never came", async () => {
    const co = addCompany(db.raw);
    const fake = new FakeStripe();
    fake.set(subscription({ id: "sub_lost", companyId: co, status: "active", periodStart: days(-33), periodEnd: days(-3), cancelAt: days(-3) }));
    await syncStripeSubscription({ db: db.d1, stripe: fake }, "sub_lost");
    expect(await hasAccess(db.d1, co)).toBe(false);
  });
});

describe("hadTrial", () => {
  it("is false for a new company and true after any trial, even a canceled one", async () => {
    const co = addCompany(db.raw);
    expect(await hadTrial(db.d1, co)).toBe(false);
    const id = addSubscription(db.raw, co, { provider: "stripe", status: "canceled" });
    expect(await hadTrial(db.d1, co)).toBe(false);
    run(db.raw, "UPDATE subscriptions SET trial_end = datetime('now', '-20 days') WHERE id = ?", id);
    expect(await hadTrial(db.d1, co)).toBe(true);
    expect((await loadBillingState(db.d1, co))?.trialAvailable).toBe(false);
  });

  it("counts a manual trial from an admin", async () => {
    const co = addCompany(db.raw);
    addSubscription(db.raw, co, { provider: "manual", status: "trialing" });
    expect(await hadTrial(db.d1, co)).toBe(true);
  });
});
