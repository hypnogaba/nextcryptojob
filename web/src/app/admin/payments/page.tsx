import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AdminNav } from "@/components/admin-nav";
import { Button } from "@/components/ui/button";
import {
  explorerUrl,
  listPaidWithoutResult,
  listStalePayments,
  MAX_REFUND_NOTE_LENGTH,
  type PaidWithoutResultRow,
} from "@/lib/admin/payments";
import { currentAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { fromSqlTime } from "@/lib/time";
import { markRefundedAction, type PaymentsAdminError } from "./actions";

export const metadata: Metadata = { title: "Payments", robots: { index: false } };

/**
 * Адмінка: оплати x402, за які клієнт не отримав результату (специфікація CRM 7.4 і 12,
 * «Paid without result»), і завислі платежі. Дані в lib/admin/payments.ts; тут лише показ і
 * позначка «Mark refunded» після ручного повернення.
 */

const ERRORS: Record<PaymentsAdminError, string> = {
  not_admin: "Only admins can do this.",
  not_found: "This payment is not waiting for a refund.",
  note_required: "Add a note: how and when the money went back (for example the refund transaction).",
  note_too_long: `Keep the note under ${MAX_REFUND_NOTE_LENGTH} characters.`,
};

const WHEN = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC",
});

const ACTION_LABELS: Record<string, string> = {
  search_candidates: "Candidate search",
  request_intro: "Intro request",
  buy_usdc_month: "USDC month",
};

const NETWORK_LABELS: Record<string, string> = {
  "eip155:8453": "Base",
  "eip155:84532": "Base Sepolia",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "Solana",
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "Solana devnet",
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function when(sql: string | null): string {
  return sql ? `${WHEN.format(fromSqlTime(sql))} UTC` : "Unknown";
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function Tx({ network, tx }: { network: string; tx: string | null }) {
  if (!tx) return <span className="text-ink-muted">none</span>;
  const url = explorerUrl(network, tx);
  const short = tx.length > 18 ? `${tx.slice(0, 10)}...${tx.slice(-6)}` : tx;
  return url ? (
    <a href={url} target="_blank" rel="noreferrer noopener" className="font-mono text-xs text-brand hover:underline" title={tx}>
      {short}
    </a>
  ) : (
    <span className="font-mono text-xs" title={tx}>{short}</span>
  );
}

function Refund({ row }: { row: PaidWithoutResultRow }) {
  if (row.refundedAt) {
    return (
      <div className="text-sm">
        <div className="font-medium text-ink">Refunded {when(row.refundedAt)}</div>
        <div className="text-ink-muted">{row.refundNote}</div>
      </div>
    );
  }
  return (
    <form action={markRefundedAction} className="grid gap-2 sm:max-w-xs">
      <input type="hidden" name="payment_id" value={row.id} />
      <label className="grid gap-1 text-sm">
        <span className="text-ink-muted">Refund note</span>
        <input
          type="text"
          name="note"
          required
          maxLength={MAX_REFUND_NOTE_LENGTH}
          placeholder="Sent 5 USDC back, tx 0x..."
          className="h-10 rounded-md border border-line-strong bg-surface px-2"
        />
      </label>
      <div>
        <Button type="submit" className="h-9 px-3">Mark refunded</Button>
      </div>
    </form>
  );
}

const TD = "py-3 pr-4 align-top";

export default async function AdminPaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  if (!(await currentAdmin())) notFound();
  const params = await searchParams;
  const [rows, stale] = await Promise.all([listPaidWithoutResult(db()), listStalePayments(db())]);
  const error = first(params.error);
  const done = first(params.done);
  const waiting = rows.filter((r) => !r.refundedAt).length;

  return (
    <section className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
      <AdminNav current="/admin/payments" />
      <h1 className="text-3xl font-semibold tracking-tight">Payments</h1>
      <p className="mt-2 max-w-prose text-sm text-ink-muted">
        x402 payments that settled but gave the payer no result: the action failed after the money moved, or its result
        could not be saved. Send the money back by hand, then mark the payment refunded with a note.
      </p>

      {error && error in ERRORS ? (
        <p role="alert" className="mt-6 rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm">
          {ERRORS[error as PaymentsAdminError]}
        </p>
      ) : null}
      {done === "refunded" ? (
        <p role="status" className="mt-6 rounded-md border border-line bg-brand-soft px-4 py-3 text-sm">
          Payment {first(params.payment)} is marked refunded.
        </p>
      ) : null}

      <h2 className="mt-10 text-xl font-semibold">
        Paid without result{rows.length > 0 ? ` (${waiting} waiting)` : ""}
      </h2>
      {rows.length === 0 ? (
        <p className="mt-4 text-ink-muted">No payments without a result.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[900px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-line text-ink-muted">
                <th scope="col" className="py-2 pr-4 font-medium">Time</th>
                <th scope="col" className="py-2 pr-4 font-medium">Company</th>
                <th scope="col" className="py-2 pr-4 font-medium">Action</th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">Amount</th>
                <th scope="col" className="py-2 pr-4 font-medium">Network and tx</th>
                <th scope="col" className="py-2 pr-4 font-medium">Reason</th>
                <th scope="col" className="py-2 font-medium">Refund</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-line" data-payment={row.id}>
                  <td className={TD}>
                    <div>{when(row.noResultAt)}</div>
                    <div className="font-mono text-xs text-ink-muted">{row.id}</div>
                  </td>
                  <td className={TD}>
                    {row.companyId ? (
                      <>
                        <div className="font-medium text-ink">{row.companyName ?? "Deleted company"}</div>
                        <div className="font-mono text-xs text-ink-muted">{row.companyId}</div>
                      </>
                    ) : (
                      <>
                        <div className="text-ink">Guest (x402)</div>
                        <div className="font-mono text-xs text-ink-muted" title={row.payer ?? ""}>{row.payer ?? "payer unknown"}</div>
                      </>
                    )}
                  </td>
                  <td className={TD}>
                    {ACTION_LABELS[row.action] ?? row.action}
                    <div className="text-xs text-ink-muted">{row.channel.toUpperCase()}</div>
                  </td>
                  <td className={`${TD} text-right tabular-nums`}>{usd(row.amountUsdCents)}</td>
                  <td className={TD}>
                    <div>{NETWORK_LABELS[row.network] ?? row.network}</div>
                    <Tx network={row.network} tx={row.tx} />
                  </td>
                  <td className={`${TD} max-w-xs break-words text-xs text-ink-muted`}>{row.reason ?? "Unknown"}</td>
                  <td className="py-3 align-top">
                    <Refund row={row} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="mt-12 text-xl font-semibold">Stuck or unconfirmed</h2>
      <p className="mt-2 max-w-prose text-sm text-ink-muted">
        Verified more than 5 minutes ago and never settled, or the facilitator gave no clear answer. Check the transaction
        on the network before doing anything.
      </p>
      {stale.length === 0 ? (
        <p className="mt-4 text-ink-muted">No stuck payments.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-line text-ink-muted">
                <th scope="col" className="py-2 pr-4 font-medium">Created</th>
                <th scope="col" className="py-2 pr-4 font-medium">Status</th>
                <th scope="col" className="py-2 pr-4 font-medium">Action</th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">Amount</th>
                <th scope="col" className="py-2 pr-4 font-medium">Network and tx</th>
                <th scope="col" className="py-2 font-medium">Error</th>
              </tr>
            </thead>
            <tbody>
              {stale.map((p) => (
                <tr key={p.id} className="border-b border-line">
                  <td className={TD}>
                    <div>{when(p.createdAt)}</div>
                    <div className="font-mono text-xs text-ink-muted">{p.id}</div>
                  </td>
                  <td className={TD}>{p.status}</td>
                  <td className={TD}>{ACTION_LABELS[p.action] ?? p.action}</td>
                  <td className={`${TD} text-right tabular-nums`}>{usd(p.amountUsdCents)}</td>
                  <td className={TD}>
                    <div>{NETWORK_LABELS[p.network] ?? p.network}</div>
                    <Tx network={p.network} tx={p.tx} />
                  </td>
                  <td className="max-w-xs break-words py-3 align-top text-xs text-ink-muted">{p.errorReason ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
