import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { currentAdmin } from "@/lib/auth/admin";
import { listCompaniesForAdmin, MAX_NOTE_LENGTH, type AdminCompanyRow } from "@/lib/billing/manual";
import { stripeSettings, type StripeEnv } from "@/lib/billing/stripe";
import { appEnv, db } from "@/lib/db";
import { fromSqlTime } from "@/lib/time";
import { grantAccessAction, revokeAccessAction, type AdminError } from "./actions";

export const metadata: Metadata = { title: "Companies", robots: { index: false } };

/**
 * Адмінка: компанії й доступ (специфікація CRM, розділ 12, лише частина T8).
 * "Grant access" дає ручний доступ (provider 'manual'), "Revoke" його знімає.
 * Решту дій з розділу 12 (Suspend, Revoke all keys) додасть доріжка адмінки.
 */

const ERRORS: Record<AdminError, string> = {
  not_admin: "Only admins can do this.",
  not_found: "Company not found.",
  invalid_status: "Choose Trial or Active.",
  invalid_period: "Pick an end date in the future, at most one year ahead.",
  note_required: "Add a note: why this company gets access.",
  note_too_long: `Keep the note under ${MAX_NOTE_LENGTH} characters.`,
};

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function subscriptionLabel(row: AdminCompanyRow): string {
  if (!row.provider) return "None";
  const end = row.periodEnd ? ` until ${DATE.format(fromSqlTime(row.periodEnd))}` : "";
  return `${row.provider}: ${row.subStatus}${end}`;
}

/** Типова дата кінця для форми: через 30 днів. */
function defaultEnd(now: Date): string {
  return new Date(now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
}

function GrantForm({ row, now }: { row: AdminCompanyRow; now: Date }) {
  const min = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-brand">Grant access</summary>
      <form action={grantAccessAction} className="mt-3 grid gap-3 sm:max-w-sm">
        <input type="hidden" name="company_id" value={row.id} />
        <label className="grid gap-1">
          <span className="text-ink-muted">Status</span>
          <select name="status" defaultValue="active" className="h-10 rounded-md border border-line-strong bg-surface px-2">
            <option value="active">Active</option>
            <option value="trialing">Trial</option>
          </select>
        </label>
        <label className="grid gap-1">
          <span className="text-ink-muted">Access until (end of day, UTC)</span>
          <input
            type="date"
            name="period_end"
            required
            min={min}
            defaultValue={defaultEnd(now)}
            className="h-10 rounded-md border border-line-strong bg-surface px-2"
          />
        </label>
        <label className="grid gap-1">
          <span className="text-ink-muted">Note</span>
          <input
            type="text"
            name="note"
            required
            maxLength={MAX_NOTE_LENGTH}
            placeholder="Hackathon jury, partner, card payments not live yet"
            className="h-10 rounded-md border border-line-strong bg-surface px-2"
          />
        </label>
        <div>
          <Button type="submit" className="h-10 px-4">Grant access</Button>
        </div>
      </form>
    </details>
  );
}

export default async function AdminCompaniesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  if (!(await currentAdmin())) notFound();
  const params = await searchParams;
  const rows = await listCompaniesForAdmin(db());
  const stripe = stripeSettings(appEnv() as unknown as StripeEnv);
  const now = new Date();

  const error = first(params.error);
  const done = first(params.done);
  const target = rows.find((r) => r.id === first(params.company))?.name ?? "the company";

  return (
    <section className="mx-auto max-w-5xl px-4 py-12 sm:px-6 sm:py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Companies</h1>
      <p className="mt-2 text-sm text-ink-muted">
        {stripe.enabled
          ? "Card payments: on."
          : `Card payments: off (${stripe.reason}). Grant access by hand below.`}
      </p>

      {error && error in ERRORS ? (
        <p role="alert" className="mt-6 rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm">
          {ERRORS[error as AdminError]}
        </p>
      ) : null}
      {done === "granted" || done === "revoked" ? (
        <p role="status" className="mt-6 rounded-md border border-line bg-brand-soft px-4 py-3 text-sm">
          {done === "granted" ? `Access granted to ${target}.` : `Manual access revoked for ${target}.`}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="mt-8 text-ink-muted">No companies yet.</p>
      ) : (
        <div className="mt-8 overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-line text-ink-muted">
                <th className="py-2 pr-4 font-medium">Company</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 font-medium">Access</th>
                <th className="py-2 pr-4 font-medium">Latest subscription</th>
                <th className="py-2 pr-4 font-medium">Members</th>
                <th className="py-2 font-medium">Manual access</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-line align-top">
                  <td className="py-3 pr-4">
                    <div className="font-medium text-ink">{row.name}</div>
                    <div className="font-mono text-xs text-ink-muted">
                      {row.id}
                      {row.kind === "agency" ? " (agency)" : ""}
                    </div>
                  </td>
                  <td className="py-3 pr-4">{row.status}</td>
                  <td className="py-3 pr-4">{row.access}</td>
                  <td className="py-3 pr-4">{subscriptionLabel(row)}</td>
                  <td className="py-3 pr-4">{row.members}</td>
                  <td className="grid gap-2 py-3">
                    <GrantForm row={row} now={now} />
                    {row.manualActive ? (
                      <form action={revokeAccessAction}>
                        <input type="hidden" name="company_id" value={row.id} />
                        <Button type="submit" variant="destructive" className="h-9 px-3">Revoke</Button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
