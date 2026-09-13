import type { z } from "zod";
import { sqlTime, startOfUtcDay } from "@/lib/time";
import type { ActionContext } from "./context";
import { ActionError, type Usage as UsageSchema } from "./types";

/**
 * Використання компанії (дія get_usage, REST GET /usage, специфікація 5.1 і W6):
 * виклики по днях і діях та витрати x402 за той самий день і дію.
 *
 * - Виклики: рядки usage_events компанії зі статусом 2xx (ті самі, що рахують квоти).
 * - Витрати: розраховані платежі x402 компанії (x402_payments.status = 'settled').
 *   Беремо їх з x402_payments, а не з usage_events: оплачене знайомство, дія якого
 *   впала вже після розрахунку, лишає рядок обліку з 500, а гроші все одно пішли.
 * - Межі: дати UTC включно; типово останні 30 днів; не більше 400 днів (стільки
 *   живе usage_events).
 */

type Usage = z.infer<typeof UsageSchema>;

const DEFAULT_DAYS = 30;
const MAX_DAYS = 400;
const DAY_MS = 86_400_000;

const invalid = (field: string, message: string) =>
  new ActionError("validation_failed", 422, "Some fields are not valid.", { fields: { [field]: message } });

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

export async function getUsage(ctx: ActionContext, input: { from?: string; to?: string }): Promise<Usage> {
  const company = ctx.company;
  if (!company) throw new ActionError("unauthorized", 401, "Send an API key.");

  const to = input.to ? new Date(`${input.to}T00:00:00Z`) : startOfUtcDay(ctx.now);
  const from = input.from ? new Date(`${input.from}T00:00:00Z`) : new Date(to.getTime() - (DEFAULT_DAYS - 1) * DAY_MS);
  if (Number.isNaN(to.getTime())) throw invalid("to", "Use a date like 2026-09-30.");
  if (Number.isNaN(from.getTime())) throw invalid("from", "Use a date like 2026-09-01.");
  if (from > to) throw invalid("from", "The start date must not be after the end date.");
  if ((to.getTime() - from.getTime()) / DAY_MS + 1 > MAX_DAYS) throw invalid("from", `Choose at most ${MAX_DAYS} days.`);

  const start = sqlTime(from);
  const end = sqlTime(new Date(to.getTime() + DAY_MS));
  const [calls, spend] = await ctx.db.batch<{ day: string; action: string; n: number }>([
    ctx.db
      .prepare(
        `SELECT date(created_at) AS day, action, COUNT(*) AS n FROM usage_events
          WHERE company_id = ? AND status BETWEEN 200 AND 299 AND created_at >= ? AND created_at < ?
          GROUP BY day, action`,
      )
      .bind(company.id, start, end),
    ctx.db
      .prepare(
        `SELECT date(COALESCE(settled_at, created_at)) AS day, action, SUM(amount_usd_cents) AS n FROM x402_payments
          WHERE company_id = ? AND status = 'settled' AND COALESCE(settled_at, created_at) >= ? AND COALESCE(settled_at, created_at) < ?
          GROUP BY day, action`,
      )
      .bind(company.id, start, end),
  ]);

  const rows = new Map<string, { date: string; action: string; calls: number; cents: number }>();
  const row = (day: string, action: string) => {
    const key = `${day} ${action}`;
    let r = rows.get(key);
    if (!r) rows.set(key, (r = { date: day, action, calls: 0, cents: 0 }));
    return r;
  };
  for (const c of calls.results) row(c.day, c.action).calls += Number(c.n);
  for (const s of spend.results) row(s.day, s.action).cents += Number(s.n);

  const days = [...rows.values()].sort((a, b) => (a.date === b.date ? a.action.localeCompare(b.action) : a.date < b.date ? -1 : 1));
  const total = days.reduce((t, d) => ({ calls: t.calls + d.calls, cents: t.cents + d.cents }), { calls: 0, cents: 0 });
  return {
    from: isoDate(from),
    to: isoDate(to),
    days: days.map((d) => ({ date: d.date, action: d.action, calls: d.calls, x402_usd: dollars(d.cents) })),
    totals: { calls: total.calls, x402_usd: dollars(total.cents) },
  };
}
