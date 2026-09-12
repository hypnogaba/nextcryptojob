import type { StripeEnv } from "@/lib/billing/stripe";
import { stripeWebhookResponse } from "@/lib/billing/webhook";
import { appEnv, db } from "@/lib/db";

/**
 * Вебхук Stripe. Кінцева точка в Stripe Dashboard:
 * https://<домен>/api/stripe/webhook, події з STRIPE_EVENTS (lib/billing/webhook.ts).
 * Уся логіка й коди відповіді там; тут лише оточення Worker.
 */
export async function POST(request: Request): Promise<Response> {
  return stripeWebhookResponse(request, { db: db(), env: appEnv() as unknown as StripeEnv });
}
