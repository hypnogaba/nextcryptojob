import { auditValues, guardedAuditStatement } from "@/lib/crm/audit";
import { sqlTime } from "@/lib/time";
import { findStalePayments, type StalePayment } from "@/lib/x402/server";

/**
 * Адмінка оплат x402 (специфікація CRM 7.4 і 12, «Paid without result»).
 *
 * «Paid without result»: гроші розраховано, а дія впала після settle або її результат не
 * записався (x402_payments.no_result_at, міграція 0016). Повернення адмін робить руками поза
 * сервісом (переказ USDC назад) і позначає тут з приміткою; позначка пише audit_log з актором
 * `admin:<user id>`. Примітку в журнал не пишемо: це вільний текст, а журнал живе довше за дані.
 * Нижче список завислих платежів (findStalePayments): 'verified' старші 5 хв і 'unconfirmed'.
 */

export const MAX_REFUND_NOTE_LENGTH = 500;
const LIST_LIMIT = 200;

export interface PaidWithoutResultRow {
  id: string;
  companyId: string | null;
  companyName: string | null;
  action: string;
  network: string;
  tx: string | null;
  payer: string | null;
  amountUsdCents: number;
  channel: string;
  reason: string | null;
  settledAt: string | null;
  noResultAt: string;
  refundedAt: string | null;
  refundNote: string | null;
}

export async function listPaidWithoutResult(db: D1Database): Promise<PaidWithoutResultRow[]> {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.company_id, c.name AS company_name, p.action, p.network, p.tx, p.payer, p.amount_usd_cents,
              p.channel, p.no_result_reason, p.settled_at, p.no_result_at, p.refunded_at, p.refund_note
         FROM x402_payments p LEFT JOIN companies c ON c.id = p.company_id
        WHERE p.no_result_at IS NOT NULL
        ORDER BY p.refunded_at IS NOT NULL, p.no_result_at DESC
        LIMIT ?`,
    )
    .bind(LIST_LIMIT)
    .all<Record<string, string | number | null>>();
  return results.map((r) => ({
    id: String(r.id),
    companyId: (r.company_id as string | null) ?? null,
    companyName: (r.company_name as string | null) ?? null,
    action: String(r.action),
    network: String(r.network),
    tx: (r.tx as string | null) ?? null,
    payer: (r.payer as string | null) ?? null,
    amountUsdCents: Number(r.amount_usd_cents),
    channel: String(r.channel),
    reason: (r.no_result_reason as string | null) ?? null,
    settledAt: (r.settled_at as string | null) ?? null,
    noResultAt: String(r.no_result_at),
    refundedAt: (r.refunded_at as string | null) ?? null,
    refundNote: (r.refund_note as string | null) ?? null,
  }));
}

export async function listStalePayments(db: D1Database): Promise<StalePayment[]> {
  return findStalePayments(db, LIST_LIMIT);
}

export type RefundResult = { ok: true } | { ok: false; reason: "not_found" | "note_required" | "note_too_long" };

/**
 * Позначити платіж без результату поверненим. Лише рядок «Paid without result», ще не
 * позначений; позначка й рядок журналу йдуть одним пакетом (журнал лише коли позначка лягла).
 */
export async function markRefunded(
  db: D1Database,
  input: { paymentId: string; adminUserId: string; note: string; now?: Date },
): Promise<RefundResult> {
  const note = input.note.trim();
  if (!note) return { ok: false, reason: "note_required" };
  if (note.length > MAX_REFUND_NOTE_LENGTH) return { ok: false, reason: "note_too_long" };
  const now = input.now ?? new Date();
  const at = sqlTime(now);
  const ctx = {
    db,
    actor: { kind: "admin" as const, userId: input.adminUserId },
    company: null,
    channel: "web" as const,
    requestId: crypto.randomUUID(),
    now,
  };
  const row = await db
    .prepare("SELECT company_id, amount_usd_cents FROM x402_payments WHERE id = ? AND no_result_at IS NOT NULL AND refunded_at IS NULL")
    .bind(input.paymentId)
    .first<{ company_id: string | null; amount_usd_cents: number }>();
  if (!row) return { ok: false, reason: "not_found" };

  const [updated] = await db.batch([
    db
      .prepare(
        `UPDATE x402_payments SET refunded_at = ?, refund_note = ?, refunded_by = ?
          WHERE id = ? AND no_result_at IS NOT NULL AND refunded_at IS NULL`,
      )
      .bind(at, note, input.adminUserId, input.paymentId),
    guardedAuditStatement(
      db,
      auditValues(ctx, {
        action: "payment.refund",
        meta: { payment_id: input.paymentId, company_id: row.company_id, amount_usd_cents: row.amount_usd_cents },
      }),
      // changes() = рядки, змінені попередньою інструкцією пакета (UPDATE вище): журнал лише за справжню позначку.
      { sql: "changes() = 1", params: [] },
    ),
  ]);
  return updated.meta.changes === 1 ? { ok: true } : { ok: false, reason: "not_found" };
}

/** Посилання на транзакцію в оглядачі мережі (Base, Base Sepolia, Solana, Solana devnet); null, якщо невідомо. */
export function explorerUrl(network: string, tx: string | null): string | null {
  if (!tx) return null;
  switch (network) {
    case "eip155:8453":
      return `https://basescan.org/tx/${tx}`;
    case "eip155:84532":
      return `https://sepolia.basescan.org/tx/${tx}`;
    case "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp":
      return `https://solscan.io/tx/${tx}`;
    case "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1":
      return `https://solscan.io/tx/${tx}?cluster=devnet`;
    default:
      return null;
  }
}

