import {
  confirmInvoice, expireStaleInvoices, listPendingInvoices, readSolanaPayConfig, type SolanaPayEnv, verifyOnChain,
} from "@/lib/billing/solana-pay";

/**
 * Пильнує Solana Pay рахунки, поки людина не натисла «Check now» чи закрила вкладку (п.8, 15.09):
 * без цього оплата, зроблена й не перевірена вручну, лишилась би 'pending' назавжди. Щогодини (cron
 * hourly, CronEnv): перевірити pending рахунки в мережі, підтвердити ті, де платіж знайшовся,
 * прострочити ті, що чекали довше за TTL (billing/solana-pay.ts SOLANA_PAY_INVOICE_TTL_MINUTES).
 * Без NCJ_PAY_ADDRESS/SOLANA_RPC_URL (0 і 0): нема сенсу питати мережу, лише прострочити старе.
 */
export async function checkPendingSolanaPay(db: D1Database, env: SolanaPayEnv, now: Date, limit = 50): Promise<Record<string, number>> {
  const expired = await expireStaleInvoices(db, now);
  const config = readSolanaPayConfig(env);
  if (!config.enabled) return { expired, checked: 0, confirmed: 0, errors: 0 };

  const pending = await listPendingInvoices(db, now, limit);
  let confirmed = 0;
  let errors = 0;
  for (const invoice of pending) {
    const result = await verifyOnChain(config.rpcUrl, invoice.reference, config.payTo, invoice.amountUsdc);
    if (result.status === "confirmed") {
      await confirmInvoice(db, invoice, result.tx, result.payer, now);
      confirmed++;
    } else if (result.status === "error") {
      console.warn("cron: solana pay verify failed", { invoiceId: invoice.id, reason: result.reason });
      errors++;
    }
  }
  return { expired, checked: pending.length, confirmed, errors };
}
