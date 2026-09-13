import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { loadBillingState, type BillingState, type SubscriptionView } from "@/lib/billing/access";
import { TRIAL_DAYS } from "@/lib/billing/checkout";
import { requestOrigin } from "@/lib/billing/origin";
import { stripeSettings, type StripeEnv } from "@/lib/billing/stripe";
import { resolveWebActor, WEB_BURST_TEXT, type ActionContext } from "@/lib/crm/context";
import { CRM_HOME } from "@/lib/crm/company";
import { can } from "@/lib/crm/permissions";
import { appEnv, db } from "@/lib/db";
import { fromSqlTime } from "@/lib/time";
import { readX402Config, type X402Env } from "@/lib/x402/config";
import { openPortalAction, startCheckoutAction, type BillingError } from "./actions";

export const metadata: Metadata = { title: "Billing", robots: { index: false } };

/**
 * Оплата компанії (специфікація CRM, 8, 7.5 і 10.2): стан доступу, Stripe
 * Checkout і портал для власника, інструкція для USDC через x402.
 * Без STRIPE_SECRET_KEY картка показує "Card payments are coming soon".
 * Оболонку CRM (перемикач, плашки, навігацію) дає layout групи (crm) (T6).
 * `?welcome=1` після реєстрації (6.1): три шляхи: пробний, USDC, оплата за запит.
 * Агенція на перевірці або відхилена сюди не потрапляє: для неї лише заявка й налаштування.
 */

const ERRORS: Record<BillingError, string> = {
  owner_only: "Only the company owner can manage billing.",
  not_configured: "Card payments are coming soon.",
  already_subscribed: "Your company already has a card subscription. Use Manage billing to change it.",
  company_not_active: "Your company account is not active, so it cannot subscribe yet.",
  no_customer: "There is no card subscription to manage yet.",
  stripe_failed: "We could not reach Stripe. Try again in a minute.",
  rate_limited: WEB_BURST_TEXT,
};

const DAY_MS = 86_400_000;
const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function date(sql: string | null): string {
  return sql ? DATE.format(fromSqlTime(sql)) : "";
}

function daysLeft(sql: string | null, now: Date): number {
  return sql ? Math.max(0, Math.ceil((fromSqlTime(sql).getTime() - now.getTime()) / DAY_MS)) : 0;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

type Tone = "info" | "warning" | "error";

function Banner({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const styles: Record<Tone, string> = {
    info: "border-line bg-brand-soft text-ink",
    warning: "border-line-strong bg-wash text-ink",
    error: "border-danger/40 bg-danger/10 text-ink",
  };
  return (
    <div role={tone === "info" ? "status" : "alert"} className={`rounded-md border px-4 py-3 text-sm ${styles[tone]}`}>
      {children}
    </div>
  );
}

/** Заголовок і пояснення поточного стану доступу. */
function describe(state: BillingState): { label: string; detail: string } {
  if (state.companyStatus === "pending_review") {
    return { label: "Under review", detail: "Your application is under review." };
  }
  if (state.companyStatus !== "active") {
    return { label: "Not active", detail: "Your company account is not active. Contact support@nextcryptojob.xyz." };
  }
  const cur: SubscriptionView | null = state.current;
  if (cur) {
    const until = date(cur.periodEnd);
    if (cur.provider === "manual") {
      return {
        label: "Access granted by NextCryptoJob",
        detail: cur.status === "trialing" ? `Trial until ${until}.` : `Active until ${until}.`,
      };
    }
    if (cur.provider === "usdc") return { label: "Paid in USDC", detail: `Active until ${until}.` };
    if (cur.status === "trialing") {
      const end = date(cur.trialEnd ?? cur.periodEnd);
      return { label: "Trial", detail: cur.cancelAt ? `Trial until ${end}. It will not renew.` : `Trial until ${end}.` };
    }
    if (cur.status === "past_due") return { label: "Past due", detail: "Your last payment failed. Update your card to keep access." };
    return {
      label: "Active",
      detail: cur.cancelAt ? `Active until ${date(cur.cancelAt)}. It will not renew.` : `Active. Renews on ${until}.`,
    };
  }
  if (state.stripe?.status === "canceled") {
    return { label: "Canceled", detail: "Your card subscription has ended. Search and intros work through the API with x402 pay per request." };
  }
  return {
    label: "No subscription",
    detail: "Search and intros work through the API with x402 pay per request. Subscribe for full CRM access.",
  };
}

function PortalButton() {
  return (
    <form action={openPortalAction} className="mt-3">
      <Button type="submit" variant="outline" className="h-10 px-4">
        Manage billing
      </Button>
    </form>
  );
}

function Banners({
  state,
  now,
  checkout,
  error,
  canManage,
}: {
  state: BillingState;
  now: Date;
  checkout?: string;
  error?: string;
  /** Власник і картки ввімкнені: у плашці можна дати кнопку порталу. */
  canManage: boolean;
}) {
  const out: React.ReactNode[] = [];
  if (checkout === "success") {
    out.push(
      <Banner key="ok" tone="info">
        Thanks. Your access starts as soon as Stripe confirms the payment, usually within a few seconds. Refresh this page
        if you do not see it yet.
      </Banner>,
    );
  }
  if (checkout === "canceled") out.push(<Banner key="cancel" tone="info">Checkout was canceled. Nothing was charged.</Banner>);
  if (error && error in ERRORS) out.push(<Banner key="err" tone="error">{ERRORS[error as BillingError]}</Banner>);

  const stripe = state.stripe;
  if (stripe && (stripe.status === "past_due" || stripe.status === "unpaid")) {
    out.push(<Banner key="failed" tone="error">Payment failed. Update your card.</Banner>);
  }
  // Перший платіж чекає підтвердження банку (3-D Secure): без нього Stripe
  // за добу закриє підписку як incomplete_expired.
  if (stripe?.status === "incomplete") {
    out.push(
      <Banner key="incomplete" tone="warning">
        <p>Confirm your payment to start the subscription.</p>
        {canManage && state.stripeCustomerId ? <PortalButton /> : null}
      </Banner>,
    );
  }
  const cur = state.current;
  if (cur?.status === "trialing") {
    const end = cur.trialEnd ?? cur.periodEnd;
    const n = daysLeft(end, now);
    out.push(
      <Banner key="trial" tone={n <= 3 ? "warning" : "info"}>
        {`Trial: ${n} ${n === 1 ? "day" : "days"} left. Your trial ends on ${date(end)}.`}
      </Banner>,
    );
  }
  return out.length > 0 ? <div className="mt-6 grid gap-3">{out}</div> : null;
}

function CardSection({ state, cardsEnabled, isOwner }: { state: BillingState; cardsEnabled: boolean; isOwner: boolean }) {
  return (
    <section aria-labelledby="card-heading" className="rounded-lg border border-line bg-surface p-5 sm:p-6">
      <h2 id="card-heading" className="text-lg font-semibold">Pay by card</h2>
      {!cardsEnabled ? (
        <>
          <p className="mt-2 font-medium text-ink">Card payments are coming soon.</p>
          <p className="mt-1 text-sm text-ink-muted">
            Until then, pay 100 USDC for 30 days below, or write to support@nextcryptojob.xyz for access.
          </p>
        </>
      ) : !isOwner ? (
        <p className="mt-2 text-sm text-ink-muted">Only the company owner can manage billing.</p>
      ) : (
        <>
          <p className="mt-2 text-sm text-ink-muted">
            $100 per month, plus VAT where it applies. Checkout shows the price in your currency and lets you add a VAT
            ID. Cancel any time: access continues to the end of the paid period.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            {state.stripeOpen ? null : (
              <form action={startCheckoutAction}>
                <Button type="submit" className="h-11 px-4 text-base">
                  {state.trialAvailable ? `Start ${TRIAL_DAYS}-day trial` : "Subscribe"}
                </Button>
              </form>
            )}
            {state.stripeCustomerId ? (
              <form action={openPortalAction}>
                <Button type="submit" variant="outline" className="h-11 px-4 text-base">
                  Manage billing
                </Button>
              </form>
            ) : null}
          </div>
          {!state.stripeOpen && state.trialAvailable ? (
            <p className="mt-3 text-sm text-ink-muted">
              {`The trial needs a card. You are charged after ${TRIAL_DAYS} days unless you cancel before then.`}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

/** Три шляхи після реєстрації компанії (6.1). */
function Welcome({ cardsEnabled, trial }: { cardsEnabled: boolean; trial: boolean }) {
  const LINK = "font-medium text-brand underline underline-offset-4";
  return (
    <section aria-labelledby="welcome-heading" className="mt-6 grid gap-3 rounded-lg border border-line bg-brand-soft p-5 sm:p-6">
      <h2 id="welcome-heading" className="text-lg font-semibold">
        Your company is ready. Choose how to start.
      </h2>
      <ol className="grid gap-2 text-sm text-ink">
        <li>
          <a href="#card-heading" className={LINK}>
            {trial ? `Start ${TRIAL_DAYS}-day trial` : "Subscribe"}
          </a>
          {cardsEnabled ? " with a card: full CRM for your team." : ". Card payments are coming soon."}
        </li>
        <li>
          <a href="#usdc-heading" className={LINK}>
            Pay 100 USDC for 30 days
          </a>{" "}
          with your agent or any x402 client.
        </li>
        <li>
          <Link href={CRM_HOME} className={LINK}>
            Continue with pay per request (API only)
          </Link>
          : search and intros through the API, paid per request with x402.
        </li>
      </ol>
    </section>
  );
}

function UsdcSection({ origin, enabled }: { origin: string; enabled: boolean }) {
  const endpoint = `${origin}/api/v1/billing/usdc-month`;
  const curl = [
    "# 1. Ask for the payment terms. The answer is 402 with a PAYMENT-REQUIRED header.",
    `curl -i -X POST ${endpoint} \\`,
    '  -H "Authorization: Bearer $NCJ_API_KEY"',
    "",
    "# 2. Sign the payment with your x402 client, then send the same request with it.",
    `curl -X POST ${endpoint} \\`,
    '  -H "Authorization: Bearer $NCJ_API_KEY" \\',
    '  -H "PAYMENT-SIGNATURE: $PAYMENT"',
  ].join("\n");
  return (
    <section aria-labelledby="usdc-heading" className="rounded-lg border border-line bg-surface p-5 sm:p-6">
      <h2 id="usdc-heading" className="text-lg font-semibold">Pay with USDC (x402)</h2>
      {enabled ? null : <p className="mt-2 font-medium text-ink">USDC payments open soon.</p>}
      <p className="mt-2 text-sm text-ink-muted">
        Pay 100 USDC on Base or Solana for 30 days of access. Your agent or any x402 client can pay with an API key of
        this company. There is no automatic renewal: pay again and the next 30 days start when the current ones end.
      </p>
      <div className="mt-4 overflow-x-auto rounded-md border border-line bg-wash">
        <pre className="p-4 font-mono text-xs leading-relaxed text-ink">
          <code>{curl}</code>
        </pre>
      </div>
      <p className="mt-3 text-sm text-ink-muted">
        Over MCP, call the <code className="font-mono">buy_usdc_month</code> tool and pass the payment in{" "}
        <code className="font-mono">{'_meta["x402/payment"]'}</code>.
      </p>
    </section>
  );
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await requireUser();
  const params = await searchParams;

  let ctx: ActionContext | null = null;
  try {
    ctx = await resolveWebActor();
  } catch {
    // Людина без компанії.
  }

  const shell = (children: React.ReactNode) => (
    <section className="mx-auto max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Billing</h1>
      {children}
    </section>
  );

  const state = ctx?.company ? await loadBillingState(db(), ctx.company.id, { userId: user.id }) : null;
  if (!ctx || ctx.actor.kind !== "member" || !state) {
    return shell(<p className="mt-4 text-ink-muted">Your account is not part of a company yet.</p>);
  }
  if (ctx.company?.status === "pending_review" || ctx.company?.status === "rejected") redirect("/company/apply");

  const env = appEnv();
  const cardsEnabled = stripeSettings(env as unknown as StripeEnv).enabled;
  const usdcEnabled = readX402Config(env as unknown as X402Env).enabled;
  const isOwner = can(ctx.actor.role, "billing.stripe");
  const origin = requestOrigin(await headers());
  const now = new Date();
  const status = describe(state);

  return shell(
    <>
      <p className="mt-2 text-ink-muted">{state.companyName}</p>
      <Banners
        state={state}
        now={now}
        checkout={first(params.checkout)}
        error={first(params.error)}
        canManage={isOwner && cardsEnabled}
      />
      {first(params.welcome) === "1" && isOwner ? <Welcome cardsEnabled={cardsEnabled} trial={state.trialAvailable} /> : null}
      <dl className="mt-8 grid gap-1">
        <dt className="font-mono text-xs tracking-widest text-ink-muted uppercase">Current plan</dt>
        <dd className="text-lg font-semibold text-ink">{status.label}</dd>
        <dd className="text-ink-muted">{status.detail}</dd>
      </dl>
      <div className="mt-8 grid grid-cols-1 gap-6">
        <CardSection state={state} cardsEnabled={cardsEnabled} isOwner={isOwner} />
        <UsdcSection origin={origin} enabled={usdcEnabled} />
      </div>
    </>,
  );
}
