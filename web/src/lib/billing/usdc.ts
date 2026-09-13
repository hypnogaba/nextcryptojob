import type { ActionContext } from "@/lib/crm/context";
import { ActionError } from "@/lib/crm/types";
import { newId } from "@/lib/ids";
import { isoTime, sqlTime } from "@/lib/time";

/**
 * Доступ за USDC на 30 днів через x402 (дія buy_usdc_month, специфікація 7.5).
 *
 * Обробник іде лише ПІСЛЯ вдалого settle ($100, шлях before_effect), тож
 * ctx.payment завжди є. Новий рядок subscriptions: provider 'usdc', status
 * 'active', початок = пізніше з «зараз» і кінця чинного USDC-періоду, кінець =
 * початок + 30 днів, last_x402_payment_id = цей платіж. Автосписання немає.
 *
 * Один платіж дає рівно один рядок: запис іде під умовою «рядка з цим платежем
 * ще немає», а ідемпотентний повтор знаходить його через findUsdcMonth.
 */

export const USDC_MONTH_DAYS = 30;
const USDC_MONTH_CENTS = 10000;

export interface UsdcMonthResult {
  subscription_id: string;
  period_end: string;
  payment_id: string;
}

/** Місяць, оплачений цим платежем (відповідь на ідемпотентний повтор); null, якщо немає. */
export async function findUsdcMonth(db: D1Database, companyId: string, paymentId: string): Promise<UsdcMonthResult | null> {
  const row = await db
    .prepare(
      `SELECT id, current_period_end FROM subscriptions
        WHERE company_id = ? AND provider = 'usdc' AND last_x402_payment_id = ?
        ORDER BY created_at LIMIT 1`,
    )
    .bind(companyId, paymentId)
    .first<{ id: string; current_period_end: string }>();
  return row ? { subscription_id: row.id, period_end: isoTime(row.current_period_end), payment_id: paymentId } : null;
}

export async function buyUsdcMonth(ctx: ActionContext): Promise<UsdcMonthResult> {
  const company = ctx.company;
  if (!company) throw new ActionError("key_required", 401, "Paying for a month needs an API key of the company.");
  const payment = ctx.payment;
  // Реєстр не пускає сюди без платежу (дія платна для будь-якої компанії).
  if (!payment) throw new ActionError("internal", 500, "Something went wrong on our side. Try again later.");

  const id = newId("sub");
  const now = sqlTime(ctx.now);
  await ctx.db
    .prepare(
      `INSERT INTO subscriptions (id, company_id, provider, plan, status, current_period_start, current_period_end,
                                  currency, amount_cents, last_x402_payment_id, created_at, updated_at)
       SELECT ?1, ?2, 'usdc', 'company_monthly', 'active', p.start, datetime(p.start, ?3), 'usdc', ?4, ?5, ?6, ?6
         FROM (SELECT MAX(?6, COALESCE((SELECT MAX(current_period_end) FROM subscriptions
                                         WHERE company_id = ?2 AND provider = 'usdc' AND status = 'active'), ?6)) AS start) p
        WHERE NOT EXISTS (SELECT 1 FROM subscriptions WHERE company_id = ?2 AND last_x402_payment_id = ?5)`,
    )
    .bind(id, company.id, `+${USDC_MONTH_DAYS} days`, USDC_MONTH_CENTS, payment.id, now)
    .run();
  const month = await findUsdcMonth(ctx.db, company.id, payment.id);
  if (!month) throw new ActionError("internal", 500, "Something went wrong on our side. Try again later.");
  return month;
}
