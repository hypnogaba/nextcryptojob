import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { H2, LINK, PAGE, PageTitle } from "@/components/crm/ui";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { loadBillingState, type BillingState, type SubscriptionView } from "@/lib/billing/access";
import { requestOrigin } from "@/lib/billing/origin";
import {
  findConfirmedMonth, loadInvoice, readSolanaPayConfig, type SolanaPayEnv, type SolanaPayInvoice, solanaPayUrl,
} from "@/lib/billing/solana-pay";
import { solanaPayQrSvg } from "@/lib/billing/solana-pay-qr";
import { stripeSettings, type StripeEnv } from "@/lib/billing/stripe";
import { resolveWebActor, WEB_BURST_TEXT, type ActionContext } from "@/lib/crm/context";
import { CRM_HOME } from "@/lib/crm/company";
import { can } from "@/lib/crm/permissions";
import { appEnv, db } from "@/lib/db";
import { fromSqlTime } from "@/lib/time";
import { readX402Config, type X402Env } from "@/lib/x402/config";
import { checkSolanaPayInvoiceAction, createSolanaPayInvoiceAction, openPortalAction, type BillingError } from "./actions";

export const metadata: Metadata = { title: "Billing", robots: { index: false } };

/**
 * Оплата компанії (п.8, 15.09, РІШЕННЯ ВЛАСНИКА: лише Solana, Stripe не потрібен): Solana Pay
 * (100 USDC/30 днів з власного гаманця людини, QR і посилання, перевірка в мережі) і x402
 * pay-per-request для агентів. Stripe (checkout, портал, вебхук) лишається в коді, не в
 * маршрутах цієї сторінки: старий стан підписки (canManage) усе ще бачить кнопку порталу,
 * але нової картки завести вже не можна.
 * Оболонку CRM (перемикач, плашки, навігацію) дає layout групи (crm) (T6).
 * `?welcome=1` після реєстрації: два шляхи, Solana Pay і pay-per-request.
 * `?invoice=<id>` показує QR/статус конкретного рахунку Solana Pay (actions.ts).
 * Агенція на перевірці або відхилена сюди не потрапляє: для неї лише заявка й налаштування.
 */

const ERRORS: Record<BillingError, string> = {
  owner_only: "Only the company owner can manage billing.",
  not_configured: "Payment is not set up yet. Write to support@nextcryptojob.xyz for access.",
  already_subscribed: "Your company already has a subscription. Use Manage billing to change it.",
  company_not_active: "Your company account is not active, so it cannot subscribe yet.",
  no_customer: "There is no card subscription to manage yet.",
  stripe_failed: "We could not reach Stripe. Try again in a minute.",
  rate_limited: WEB_BURST_TEXT,
  not_found: "That payment link is gone. Get a new one below.",
  rpc_failed: "We could not check the Solana network just now. Try again in a minute.",
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
    info: "border-line bg-surface text-ink",
    warning: "border-line-strong bg-wash text-ink",
    error: "border-destructive/50 bg-surface text-ink",
  };
  return (
    <div role={tone === "info" ? "status" : "alert"} className={`rounded-lg border px-4 py-3 text-sm ${styles[tone]}`}>
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
  return out.length > 0 ? <div className="grid gap-3">{out}</div> : null;
}

const CLOCK = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: false });

/**
 * Solana Pay (п.8, 15.09, РІШЕННЯ ВЛАСНИКА: лише Solana): 100 USDC/міс з власного гаманця людини,
 * без картки й без ПДВ. QR і посилання рендерить сторінка (SSR, без клієнтського JS): «Check now»
 * шле форму на checkSolanaPayInvoiceAction, а цикл cron (lib/cron/solana-pay-check.ts) все одно
 * пильнує в фоні, тож оплата зараховується, навіть якщо людина закрила вкладку не дочекавшись.
 */
function SolanaPaySection({
  isOwner, invoice, checked, payTo, periodEnd,
}: {
  isOwner: boolean;
  invoice: SolanaPayInvoice | null;
  checked: boolean;
  /** Адреса, куди йдуть гроші (NCJ_PAY_ADDRESS); null, якщо Solana Pay ще не налаштовано. */
  payTo: string | null;
  /** Кінець оплаченого періоду, коли invoice.status === 'confirmed'. */
  periodEnd: string | null;
}) {
  return (
    <section aria-labelledby="solana-pay-heading" className="scroll-mt-6 rounded-xl border border-line bg-surface p-4 sm:p-6">
      <h2 id="solana-pay-heading" className={H2}>
        Pay with Solana Pay
      </h2>
      {!payTo ? (
        <p className="mt-3 font-semibold text-ink">Solana Pay is not set up yet. Write to support@nextcryptojob.xyz for access.</p>
      ) : !isOwner ? (
        <p className="mt-3 text-sm text-ink-muted">Only the company owner can manage billing.</p>
      ) : invoice?.status === "confirmed" ? (
        <>
          <p className="mt-3 font-semibold text-ink">Paid. Access continues until {periodEnd ? date(periodEnd) : "the new end date"}.</p>
          <form action={createSolanaPayInvoiceAction} className="mt-4">
            <Button type="submit" variant="outline" className="h-11 px-4 text-base">
              Pay for another 30 days
            </Button>
          </form>
        </>
      ) : invoice && invoice.status === "pending" ? (
        <>
          <p className="mt-3 max-w-[65ch] text-sm text-ink-muted">
            Payment in crypto: 100 USDC on Solana, from your own wallet, one payment for 30 days. Access does not
            renew on its own: pay again when the 30 days are up.
          </p>
          {checked ? (
            <p role="status" className="mt-3 rounded-lg border border-line bg-wash px-4 py-3 text-sm text-ink">
              Not found yet. If you already sent it, wait a few seconds and check again.
            </p>
          ) : null}
          <div className="mt-4 grid gap-4 sm:grid-cols-[auto_1fr] sm:items-start">
            <div
              className="h-[192px] w-[192px] shrink-0 [&_svg]:h-full [&_svg]:w-full"
              // SVG з нашого коду (qrcode-generator), не з людського вводу.
              dangerouslySetInnerHTML={{ __html: solanaPayQrSvg(solanaPayUrl({
                payTo, amount: invoice.amountUsdc, reference: invoice.reference,
                label: "NextCryptoJob", message: "100 USDC for 30 days of NextCryptoJob access",
              })) }}
            />
            <div className="grid gap-3">
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-ink-muted">Amount</dt>
                <dd className="font-semibold text-ink">{invoice.amountUsdc} USDC</dd>
                <dt className="text-ink-muted">Link expires</dt>
                <dd className="text-ink">{CLOCK.format(new Date(invoice.expiresAt))} UTC</dd>
              </dl>
              <a
                href={solanaPayUrl({
                  payTo, amount: invoice.amountUsdc, reference: invoice.reference,
                  label: "NextCryptoJob", message: "100 USDC for 30 days of NextCryptoJob access",
                })}
                className={`${LINK} w-fit`}
              >
                Open in wallet
              </a>
              <form action={checkSolanaPayInvoiceAction}>
                <input type="hidden" name="invoice_id" value={invoice.id} />
                <Button type="submit" className="h-11 px-4 text-base">
                  Check now
                </Button>
              </form>
            </div>
          </div>
        </>
      ) : (
        <>
          <p className="mt-3 max-w-[65ch] text-sm text-ink-muted">
            Payment in crypto: 100 USDC on Solana, from your own wallet, one payment for 30 days. Scan a QR or open
            the link with any Solana wallet (Phantom, Solflare, and the rest). Access does not renew on its own.
          </p>
          {invoice?.status === "expired" ? (
            <div className="mt-2 grid gap-2">
              <p className="text-sm text-ink-muted">That payment link expired. Get a new one below. Already paid with it? Check it first.</p>
              {checked ? (
                <p role="status" className="rounded-lg border border-line bg-wash px-4 py-3 text-sm text-ink">
                  No payment found for that link.
                </p>
              ) : null}
              <form action={checkSolanaPayInvoiceAction}>
                <input type="hidden" name="invoice_id" value={invoice.id} />
                <Button type="submit" variant="outline" className="h-11 px-4 text-base">
                  Check my payment
                </Button>
              </form>
            </div>
          ) : null}
          <form action={createSolanaPayInvoiceAction} className="mt-4">
            <Button type="submit" className="h-11 px-4 text-base">
              Get payment link
            </Button>
          </form>
        </>
      )}
    </section>
  );
}

/** Два шляхи після реєстрації компанії (п.8, 15.09: Stripe прибрано, лишились Solana Pay і x402 pay-per-request). */
function Welcome() {
  return (
    <section aria-labelledby="welcome-heading" className="grid gap-4 rounded-xl border-[1.5px] border-line bg-surface p-4 sm:p-6">
      <h2 id="welcome-heading" className={H2}>
        Your company is ready. Choose how to start.
      </h2>
      <ol className="grid gap-3 text-sm text-ink">
        <li>
          <a href="#solana-pay-heading" className={LINK}>
            Pay 100 USDC on Solana
          </a>{" "}
          from your own wallet: full CRM for your team, 30 days.
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
    <section aria-labelledby="usdc-heading" className="scroll-mt-6 rounded-xl border border-line bg-surface p-4 sm:p-6">
      <h2 id="usdc-heading" className={H2}>
        Pay with USDC (x402)
      </h2>
      {enabled ? null : <p className="mt-3 font-semibold text-ink">USDC payments open soon.</p>}
      <p className="mt-3 max-w-[65ch] text-sm text-ink-muted">
        Pay 100 USDC on Solana for 30 days of access. Your agent or any x402 client can pay with an API key of this
        company. There is no automatic renewal: pay again and the next 30 days start when the current ones end.
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
    <section className={`${PAGE} max-w-7xl *:max-w-3xl`}>
      <PageTitle>Billing</PageTitle>
      {children}
    </section>
  );

  const state = ctx?.company ? await loadBillingState(db(), ctx.company.id, { userId: user.id }) : null;
  if (!ctx || ctx.actor.kind !== "member" || !state) {
    return shell(<p className="text-ink-muted">Your account is not part of a company yet.</p>);
  }
  if (ctx.company?.status === "pending_review" || ctx.company?.status === "rejected") redirect("/company/apply");

  const env = appEnv();
  // Плашки минулого Stripe-стану (якщо він у когось лишився) керуються тим самим правом: /company/billing
  // більше не пропонує картку (п.8), але вже наявний Stripe-стан не втрачає кнопку порталу.
  const cardsEnabled = stripeSettings(env as unknown as StripeEnv).enabled;
  const usdcEnabled = readX402Config(env as unknown as X402Env).enabled;
  const solanaPay = readSolanaPayConfig(env as unknown as SolanaPayEnv);
  const isOwner = can(ctx.actor.role, "billing.stripe");
  const origin = requestOrigin(await headers());
  const now = new Date();
  const status = describe(state);

  const invoiceId = first(params.invoice);
  const invoice = invoiceId ? await loadInvoice(db(), ctx.actor.companyId, invoiceId) : null;
  const periodEnd = invoice?.status === "confirmed" ? (await findConfirmedMonth(db(), invoice.id))?.periodEnd ?? null : null;

  return shell(
    <>
      <p className="-mt-3 text-ink-muted">{state.companyName}</p>
      <Banners
        state={state}
        now={now}
        checkout={first(params.checkout)}
        error={first(params.error)}
        canManage={isOwner && cardsEnabled}
      />
      {first(params.welcome) === "1" && isOwner ? <Welcome /> : null}
      <dl className="grid gap-1 border-y-2 border-ink py-4">
        <dt className="text-sm font-semibold text-ink-muted">Current plan</dt>
        <dd className="display text-[1.75rem] leading-none">{status.label}</dd>
        <dd className="text-ink-muted">{status.detail}</dd>
      </dl>
      <div className="grid grid-cols-1 gap-6">
        <SolanaPaySection
          isOwner={isOwner}
          invoice={invoice}
          checked={first(params.checked) === "1"}
          payTo={solanaPay.enabled ? solanaPay.payTo : null}
          periodEnd={periodEnd}
        />
        <UsdcSection origin={origin} enabled={usdcEnabled} />
      </div>
    </>,
  );
}
