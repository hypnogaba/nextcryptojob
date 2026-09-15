import { SOLANA_PAY_REMINDER_DAYS } from "@/lib/billing/solana-pay";
import { deliver, notifierFromEnv, type Notifier, type NotifyEnv } from "@/lib/crm/notify";
import { escapeHtml } from "@/lib/telegram/send";
import { sqlTime } from "@/lib/time";

/**
 * Нагадування за SOLANA_PAY_REMINDER_DAYS днів до кінця оплаченого періоду USDC (п.8, 15.09):
 * доступ на 30 днів не продовжується сам, тож компанія має дізнатись заздалегідь, а не в день,
 * коли доступ уже впав. Той самий провайдер 'usdc' для x402 (buy_usdc_month) і Solana Pay: обидва
 * дають рядок subscriptions, різниці для нагадування немає.
 *
 * Раз на рядок subscriptions (один оплачений період): reminded_at ставиться відразу, тож повторний
 * запуск (щогодини) той самий рядок не чіпає. Компанія, що вже оплатила наступний період заздалегідь
 * (є активний usdc-рядок, що починається на дату чи пізніше закінчення цього), нагадування не отримує:
 * продовжувати вже нема чого.
 */

export interface ReminderResult {
  checked: number;
  reminded: number;
  notDelivered: number;
}

type DueRow = { id: string; company_id: string; current_period_end: string; company_name: string };
type Person = { channel: "email" | "telegram"; telegram_id: string | null; email: string | null };

async function owners(db: D1Database, companyId: string): Promise<Person[]> {
  const { results } = await db
    .prepare(
      `SELECT u.channel, u.telegram_id, u.email FROM company_members m JOIN users u ON u.id = m.user_id
        WHERE m.company_id = ? AND m.role = 'owner' ORDER BY m.id`,
    )
    .bind(companyId)
    .all<Person>();
  return results;
}

const DATE = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

function reminderMessage(o: { companyName: string; periodEnd: string; billingUrl: string }) {
  const when = DATE.format(new Date(o.periodEnd));
  const title = `Your NextCryptoJob access ends on ${when}`;
  const body = `Pay 100 USDC on Solana to add 30 more days. Access does not renew on its own.`;
  return {
    telegramHtml: `${escapeHtml(title)}\n${escapeHtml(body)}\n\n<a href="${escapeHtml(o.billingUrl)}">Open billing</a>`,
    email: {
      subject: title,
      text: `${title}\n\n${body}\n\nOpen billing: ${o.billingUrl}\n`,
      html:
        `<p>${escapeHtml(title)}</p><p>${escapeHtml(body)}</p>` +
        `<p><a href="${escapeHtml(o.billingUrl)}" style="display:inline-block;padding:10px 16px;border-radius:6px;` +
        `background:#0b6e63;color:#ffffff;text-decoration:none;font-weight:600">Open billing</a></p>`,
    },
  };
}

/**
 * Активні USDC-періоди, що закінчуються за SOLANA_PAY_REMINDER_DAYS днів чи раніше (але ще не
 * скінчились) і ще без нагадування, без наступного вже оплаченого періоду.
 */
async function dueSubscriptions(db: D1Database, now: Date, limit: number): Promise<DueRow[]> {
  const windowEnd = sqlTime(new Date(now.getTime() + SOLANA_PAY_REMINDER_DAYS * 86_400_000));
  const { results } = await db
    .prepare(
      `SELECT s.id, s.company_id, s.current_period_end, c.name AS company_name
         FROM subscriptions s JOIN companies c ON c.id = s.company_id
        WHERE s.provider = 'usdc' AND s.status = 'active' AND s.reminded_at IS NULL
          AND s.current_period_end <= ?1 AND s.current_period_end > ?2
          AND NOT EXISTS (
                SELECT 1 FROM subscriptions n
                 WHERE n.company_id = s.company_id AND n.provider = 'usdc' AND n.status = 'active'
                   AND n.current_period_start >= s.current_period_end)
        ORDER BY s.current_period_end
        LIMIT ?3`,
    )
    .bind(windowEnd, sqlTime(now), limit)
    .all<DueRow>();
  return results;
}

export interface ReminderOptions {
  env?: NotifyEnv;
  notifier?: Notifier;
  now?: Date;
  limit?: number;
}

export async function sendExpiryReminders(db: D1Database, o: ReminderOptions = {}): Promise<ReminderResult> {
  const now = o.now ?? new Date();
  const notifier = o.notifier ?? notifierFromEnv(o.env ?? {});
  const billingUrl = new URL("/company/billing", notifier.origin).toString();
  const out: ReminderResult = { checked: 0, reminded: 0, notDelivered: 0 };

  for (const row of await dueSubscriptions(db, now, o.limit ?? 200)) {
    out.checked++;
    // Позначити відразу: лише якщо ще не позначено (інший запуск міг устигнути першим).
    const marked = await db
      .prepare(`UPDATE subscriptions SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL`)
      .bind(sqlTime(now), row.id)
      .run();
    if ((marked.meta.changes ?? 0) !== 1) continue;

    const message = reminderMessage({ companyName: row.company_name, periodEnd: row.current_period_end, billingUrl });
    let sent = 0;
    for (const p of await owners(db, row.company_id)) {
      const res = await deliver({ channel: p.channel, telegramId: p.telegram_id, email: p.email }, message, notifier);
      if (res.ok) sent++;
      else console.warn("billing-reminders: not delivered", { subscriptionId: row.id, error: res.error });
    }
    if (sent === 0) out.notDelivered++;
    out.reminded++;
  }
  return out;
}
