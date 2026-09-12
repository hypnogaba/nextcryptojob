import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomToken, sha256Hex } from "@/lib/auth/hash";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { days, FakeStripe, subscription } from "@/lib/billing/stripe-fixtures";
import { syncStripeSubscription } from "@/lib/billing/webhook";
import type { AppEnv } from "@/lib/db";
import { addCompany, addMember, addSubscription, addUser, crmDb } from "@/test/crm-fixtures";
import { exec, harness, RedirectCalled, resetHarness } from "@/test/harness";
import { openPortalAction, startCheckoutAction } from "./actions";
import BillingPage from "./page";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/navigation", async () => (await import("@/test/harness")).navigationModule);

// Справжній stripeClient, лише мережу замінено: з ключем віддає FakeStripe, без ключа null.
const stripeHolder = vi.hoisted(() => ({ fake: null as unknown }));
vi.mock("@/lib/billing/stripe", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/billing/stripe")>();
  return { ...mod, stripeClient: (env: Parameters<typeof mod.stripeClient>[0]) => (mod.stripeClient(env) ? stripeHolder.fake : null) };
});

const STRIPE_ON = { STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_PRICE_ID: "price_1S9xNcjTestMonthly" };
let fake: FakeStripe;
let company: string;
let owner: string;

function setup(env: Record<string, string> = {}) {
  resetHarness(env as Partial<AppEnv>);
  const { raw, d1 } = crmDb();
  harness.raw = raw;
  harness.env.DB = d1;
  harness.headers = new Headers({ host: "nextcryptojob.xyz" });
  fake = new FakeStripe();
  stripeHolder.fake = fake;
  company = addCompany(raw, { name: "Acme Labs" });
  owner = addUser(raw, { email: "dana@acme.io" });
  addMember(raw, company, owner, "owner");
}

async function signIn(userId: string): Promise<void> {
  const token = randomToken();
  exec("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))", await sha256Hex(token), userId);
  harness.jar.set(SESSION_COOKIE, token);
}

async function render(params: Record<string, string> = {}): Promise<string> {
  const html = renderToStaticMarkup(await BillingPage({ searchParams: Promise.resolve(params) }));
  return html.replaceAll("&quot;", '"').replaceAll("&#x27;", "'");
}

async function redirectOf(action: () => Promise<void>): Promise<string> {
  const err = await action().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(RedirectCalled);
  return (err as RedirectCalled).url;
}

async function stripeSays(o: Parameters<typeof subscription>[0]) {
  const sub = subscription({ companyId: company, ...o });
  fake.set(sub);
  await syncStripeSubscription({ db: harness.env.DB, stripe: fake }, sub.id);
}

describe("billing page without Stripe keys", () => {
  beforeEach(async () => {
    setup();
    await signIn(owner);
  });

  it("says card payments are coming soon and shows the USDC x402 steps", async () => {
    const html = await render();
    expect(html).toContain("Card payments are coming soon.");
    expect(html).not.toContain("Start 14-day trial");
    expect(html).not.toContain("Manage billing");
    expect(html).toContain("Pay with USDC (x402)");
    expect(html).toContain("curl -i -X POST https://nextcryptojob.xyz/api/v1/billing/usdc-month");
    expect(html).toContain('-H "PAYMENT-SIGNATURE: $PAYMENT"');
    expect(html).toContain("buy_usdc_month");
    expect(html).toContain("No subscription");
  });

  it("the checkout button, if pressed anyway, comes back with the same message", async () => {
    expect(await redirectOf(startCheckoutAction)).toBe("/company/billing?error=not_configured");
    expect(await render({ error: "not_configured" })).toContain("Card payments are coming soon.");
  });

  it("shows manual access from an admin with the trial banner", async () => {
    addSubscription(harness.raw, company, { provider: "manual", status: "trialing", end: "2099-01-01 00:00:00" });
    exec("UPDATE subscriptions SET current_period_end = datetime('now', '+5 days', '-1 minute')");
    const html = await render();
    expect(html).toContain("Access granted by NextCryptoJob");
    expect(html).toContain("Trial: 5 days left.");
  });

  it("shows a paid USDC period", async () => {
    addSubscription(harness.raw, company, { provider: "usdc", status: "active", end: "2099-01-01 00:00:00" });
    const html = await render();
    expect(html).toContain("Paid in USDC");
    expect(html).toContain("Active until Jan 1, 2099.");
  });
});

describe("billing page with Stripe", () => {
  beforeEach(async () => {
    setup(STRIPE_ON);
    await signIn(owner);
  });

  it("offers the 14-day trial to a new company and sends the owner to Checkout", async () => {
    expect(await render()).toContain("Start 14-day trial");
    expect(await redirectOf(startCheckoutAction)).toBe("https://checkout.stripe.com/c/pay/cs_test_1");
    expect(fake.checkoutCalls[0]).toMatchObject({
      client_reference_id: company,
      customer_email: "dana@acme.io",
      subscription_data: { trial_period_days: 14 },
      success_url: "https://nextcryptojob.xyz/company/billing?checkout=success",
    });
  });

  it("offers Subscribe without trial after the trial was used, and Manage billing for the old customer", async () => {
    await stripeSays({ id: "sub_old", customer: "cus_acme", status: "canceled", trialEnd: days(-40), canceledAt: days(-10) });
    const html = await render();
    expect(html).toContain("Subscribe");
    expect(html).not.toContain("Start 14-day trial");
    expect(html).toContain("Manage billing");
    expect(html).toContain("Canceled");
  });

  it("shows the trial and only Manage billing while a Stripe trial runs", async () => {
    await stripeSays({ id: "sub_t", customer: "cus_acme", status: "trialing", periodEnd: days(10), trialEnd: days(10) });
    const html = await render();
    expect(html).toContain("Trial until");
    expect(html).toContain("Trial: 10 days left.");
    expect(html).not.toContain("Start 14-day trial");
    expect(html).toContain("Manage billing");
    expect(await redirectOf(openPortalAction)).toBe("https://billing.stripe.com/p/session/test_1");
  });

  it("shows Payment failed when the card was declined", async () => {
    await stripeSays({ id: "sub_pd", customer: "cus_acme", status: "past_due", periodStart: days(-32), periodEnd: days(-2) });
    const html = await render();
    expect(html).toContain("Payment failed. Update your card.");
    expect(html).toContain("Past due");
  });

  it("shows when a canceled subscription stops", async () => {
    await stripeSays({ id: "sub_c", customer: "cus_acme", status: "active", periodEnd: days(9), cancelAt: days(9) });
    expect(await render()).toContain("It will not renew.");
  });

  it("the portal needs a Stripe customer first", async () => {
    expect(await redirectOf(openPortalAction)).toBe("/company/billing?error=no_customer");
  });

  it("confirms the return from Checkout", async () => {
    expect(await render({ checkout: "success" })).toContain("Your access starts as soon as Stripe confirms the payment");
  });
});

describe("billing page for people who are not the owner", () => {
  it("a member sees the status but cannot pay", async () => {
    setup(STRIPE_ON);
    const member = addUser(harness.raw, { email: "lee@acme.io" });
    addMember(harness.raw, company, member, "member");
    await signIn(member);
    const html = await render();
    expect(html).toContain("Only the company owner can manage billing.");
    expect(html).not.toContain("Start 14-day trial");
    expect(await redirectOf(startCheckoutAction)).toBe("/company/billing?error=owner_only");
    expect(fake.checkoutCalls).toEqual([]);
  });

  it("a person without a company is told so", async () => {
    setup(STRIPE_ON);
    const loner = addUser(harness.raw, { email: "solo@example.com" });
    await signIn(loner);
    expect(await render()).toContain("Your account is not part of a company yet.");
  });

  it("a visitor without a session goes to sign in", async () => {
    setup(STRIPE_ON);
    const err = await BillingPage({ searchParams: Promise.resolve({}) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedirectCalled);
    expect((err as RedirectCalled).url).toBe("/login");
  });
});
