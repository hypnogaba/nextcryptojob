import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AdminNav } from "@/components/admin-nav";
import { BOARD, TABLE, TD_TIGHT, TH_TIGHT, TR } from "@/components/board";
import { Button } from "@/components/ui/button";
import { currentAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { fromSqlTime } from "@/lib/time";
import { listTestimonialsForAdmin, type AdminTestimonialRow } from "@/lib/testimonials";
import { setTestimonialStatusAction } from "./actions";

export const metadata: Metadata = { title: "Testimonials", robots: { index: false } };

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

const ERRORS: Record<string, string> = {
  not_admin: "Only admins can do this.",
  not_found: "Testimonial not found.",
  invalid_status: "Choose Approve, Hide or Pending.",
};

const DONE: Record<string, string> = {
  approved: "Approved. It can show publicly once the Testimonials block is placed on a page.",
  hidden: "Hidden.",
  pending: "Back to pending.",
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function who(t: AdminTestimonialRow): string {
  return t.displayName || t.userEmail || (t.userId ? t.userId : "Guest");
}

function StatusActions({ t }: { t: AdminTestimonialRow }) {
  return (
    <form action={setTestimonialStatusAction} className="flex flex-wrap gap-2">
      <input type="hidden" name="id" value={t.id} />
      {t.status !== "approved" ? (
        <Button type="submit" name="status" value="approved" size="sm">
          Approve
        </Button>
      ) : null}
      {t.status !== "hidden" ? (
        <Button type="submit" name="status" value="hidden" variant="outline" size="sm">
          Hide
        </Button>
      ) : null}
      {t.status !== "pending" ? (
        <Button type="submit" name="status" value="pending" variant="ghost" size="sm">
          Back to pending
        </Button>
      ) : null}
    </form>
  );
}

export default async function AdminTestimonialsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  if (!(await currentAdmin())) notFound();
  const params = await searchParams;
  const error = first(params.error);
  const done = first(params.done);
  const { rows, available, error: loadError } = await listTestimonialsForAdmin(db());

  return (
    <section className="mx-auto px-[clamp(16px,4vw,56px)] pt-8 pb-20 sm:pt-12 max-w-5xl">
      <AdminNav current="/admin/testimonials" />
      <h1 className="display text-title">Testimonials</h1>
      <p className="mt-2 text-sm text-ink-muted">
        Approve stories to allow the public Testimonials block to show them (with consent to show publicly). Hide removes a story from that block.
      </p>

      {error && error in ERRORS ? (
        <p role="alert" className="mt-6 rounded-lg border border-destructive/50 bg-surface px-4 py-3 text-sm text-ink">
          {ERRORS[error]}
        </p>
      ) : null}
      {done && done in DONE ? (
        <p role="status" className="mt-6 rounded-lg border border-line bg-surface px-4 py-3 text-sm text-ink">
          {DONE[done]}
        </p>
      ) : null}

      {!available ? (
        <p className="mt-8 text-sm text-ink-muted">{loadError}</p>
      ) : rows.length === 0 ? (
        <p className="mt-8 text-sm text-ink-muted">No testimonials yet.</p>
      ) : (
        <div className={`mt-8 ${BOARD}`}>
          <table className={TABLE}>
            <thead>
              <tr>
                <th className={TH_TIGHT}>When</th>
                <th className={TH_TIGHT}>From</th>
                <th className={TH_TIGHT}>Company / role</th>
                <th className={TH_TIGHT}>Story</th>
                <th className={TH_TIGHT}>Show as</th>
                <th className={TH_TIGHT}>Public ok</th>
                <th className={TH_TIGHT}>Status</th>
                <th className={TH_TIGHT}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className={TR}>
                  <td className={TD_TIGHT}>{DATE.format(fromSqlTime(t.createdAt))}</td>
                  <td className={TD_TIGHT}>{who(t)}</td>
                  <td className={TD_TIGHT}>{[t.role, t.company].filter(Boolean).join(", ") || "-"}</td>
                  <td className={`${TD_TIGHT} max-w-md whitespace-pre-line break-words`}>{t.text}</td>
                  <td className={`${TD_TIGHT} capitalize`}>{t.display}</td>
                  <td className={TD_TIGHT}>{t.consentPublic ? "Yes" : "No"}</td>
                  <td className={`${TD_TIGHT} capitalize`}>{t.status}</td>
                  <td className={TD_TIGHT}>
                    <StatusActions t={t} />
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
