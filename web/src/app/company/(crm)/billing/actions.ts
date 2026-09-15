"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/session";
import { createCheckout, type CheckoutResult } from "@/lib/billing/checkout";
import { requestOrigin } from "@/lib/billing/origin";
import { createPortal, type PortalResult } from "@/lib/billing/portal";
import {
  confirmInvoice, createInvoice, loadInvoice, readSolanaPayConfig, type SolanaPayEnv, verifyOnChain,
} from "@/lib/billing/solana-pay";
import { stripeClient, stripeSettings, type StripeEnv } from "@/lib/billing/stripe";
import { crmActionActor, type ActionContext } from "@/lib/crm/context";
import { can } from "@/lib/crm/permissions";
import { ActionError } from "@/lib/crm/types";
import { appEnv, db } from "@/lib/db";

/**
 * Кнопки сторінки оплати. Лише власник компанії (права, розділ 2.2:
 * "Оплата: Stripe Checkout, портал" = owner). Успіх веде на Stripe,
 * невдача назад на /company/billing?error=<код>, текст дає сторінка.
 * redirect() кидає виняток, тому стоїть поза try.
 */

const BILLING = "/company/billing";

export type BillingError =
  | "owner_only"
  | "not_configured"
  | "already_subscribed"
  | "company_not_active"
  | "no_customer"
  | "stripe_failed"
  | "rate_limited"
  | "not_found"
  | "rpc_failed";

function fail(code: BillingError): never {
  redirect(`${BILLING}?error=${code}`);
}

async function owner(): Promise<{ companyId: string; userId: string; email: string | null }> {
  const user = await currentUser();
  if (!user) redirect("/login");
  let ctx: ActionContext | null = null;
  let limited = false;
  try {
    ctx = await crmActionActor();
  } catch (err) {
    // Забагато дій (RL_WEB) сторінка пояснить; не член жодної компанії: сторінка сама скаже, що робити.
    limited = err instanceof ActionError && err.code === "rate_limited";
  }
  if (limited) fail("rate_limited");
  if (!ctx) redirect(BILLING);
  if (ctx.actor.kind !== "member" || !can(ctx.actor.role, "billing.stripe")) fail("owner_only");
  return { companyId: ctx.actor.companyId, userId: user.id, email: user.email };
}

export async function startCheckoutAction(): Promise<void> {
  const { companyId, userId, email } = await owner();
  const env = appEnv() as unknown as StripeEnv;
  const settings = stripeSettings(env);
  const stripe = stripeClient(env);
  if (!settings.enabled || !stripe) fail("not_configured");

  const origin = requestOrigin(await headers());
  let res: CheckoutResult | null = null;
  try {
    res = await createCheckout({ db: db(), stripe, priceId: settings.priceId }, { companyId, email, userId, origin });
  } catch (err) {
    console.error("stripe checkout failed:", err instanceof Error ? err.message : String(err));
  }
  if (!res) fail("stripe_failed");
  if (!res.ok) {
    fail(res.reason === "already_subscribed" || res.reason === "company_not_active" ? res.reason : "stripe_failed");
  }
  redirect(res.url);
}

export async function openPortalAction(): Promise<void> {
  const { companyId } = await owner();
  const stripe = stripeClient(appEnv() as unknown as StripeEnv);
  if (!stripe) fail("not_configured");

  const origin = requestOrigin(await headers());
  let res: PortalResult | null = null;
  try {
    res = await createPortal({ db: db(), stripe }, { companyId, origin });
  } catch (err) {
    console.error("stripe portal failed:", err instanceof Error ? err.message : String(err));
  }
  if (!res) fail("stripe_failed");
  if (!res.ok) fail(res.reason === "no_customer" ? "no_customer" : "stripe_failed");
  redirect(res.url);
}

/**
 * Кнопки Solana Pay (п.8, 15.09): «Get payment link» робить рахунок і веде на ту саму сторінку
 * з ?invoice=<id> (QR і посилання рендерить сторінка), «Check now» звіряє цей рахунок у мережі
 * одразу, не чекаючи години cron (lib/cron/solana-pay-check.ts перевіряє те саме в фоні).
 */
export async function createSolanaPayInvoiceAction(): Promise<void> {
  const { companyId, userId } = await owner();
  const config = readSolanaPayConfig(appEnv() as unknown as SolanaPayEnv);
  if (!config.enabled) fail("not_configured");
  const invoice = await createInvoice(db(), companyId, userId, new Date());
  redirect(`${BILLING}?invoice=${invoice.id}`);
}

export async function checkSolanaPayInvoiceAction(form: FormData): Promise<void> {
  const { companyId } = await owner();
  const invoiceId = String(form.get("invoice_id") ?? "");
  const invoice = await loadInvoice(db(), companyId, invoiceId);
  if (!invoice) fail("not_found");
  // Прострочений рахунок теж перевіряємо: платіж міг прийти після строку посилання, гроші вже в гаманці власника.
  if (invoice.status === "confirmed") redirect(`${BILLING}?invoice=${invoice.id}`);

  const config = readSolanaPayConfig(appEnv() as unknown as SolanaPayEnv);
  if (!config.enabled) fail("not_configured");
  const result = await verifyOnChain(config.rpcUrl, invoice.reference, config.payTo, invoice.amountUsdc);
  if (result.status === "error") {
    console.error("solana pay verify failed:", result.reason);
    fail("rpc_failed");
  }
  if (result.status === "confirmed") await confirmInvoice(db(), invoice, result.tx, result.payer, new Date());
  redirect(`${BILLING}?invoice=${invoice.id}${result.status === "pending" ? "&checked=1" : ""}`);
}
