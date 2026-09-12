import { loadBillingState } from "./access";
import type { StripeApi } from "./stripe";

/**
 * "Manage billing": Stripe Customer Portal (специфікація CRM, розділ 8).
 * Там власник скасовує підписку, міняє картку, бачить рахунки й VAT ID.
 * Що саме дозволено в порталі, налаштовується в Stripe Dashboard
 * (Settings > Billing > Customer portal), не тут.
 */

export interface PortalDeps {
  db: D1Database;
  stripe: Pick<StripeApi, "billingPortal">;
}

export type PortalResult = { ok: true; url: string } | { ok: false; reason: "not_found" | "no_customer" };

export async function createPortal(deps: PortalDeps, input: { companyId: string; origin: string }): Promise<PortalResult> {
  const state = await loadBillingState(deps.db, input.companyId);
  if (!state) return { ok: false, reason: "not_found" };
  if (!state.stripeCustomerId) return { ok: false, reason: "no_customer" };
  const session = await deps.stripe.billingPortal.sessions.create({
    customer: state.stripeCustomerId,
    return_url: `${input.origin}/company/billing`,
  });
  return { ok: true, url: session.url };
}
