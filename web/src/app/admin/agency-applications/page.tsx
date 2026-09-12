import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { currentAdmin } from "@/lib/auth/admin";
import { listApplicationsForAdmin, REVIEW_NOTE_MAX, type AdminApplication } from "@/lib/crm/agency";
import { countryName } from "@/lib/crm/countries";
import { db } from "@/lib/db";
import { fromSqlTime } from "@/lib/time";
import { reviewApplicationAction } from "./actions";

export const metadata: Metadata = { title: "Agency applications", robots: { index: false } };

/**
 * Адмінка: черга заявок агенцій (специфікація 6.2, 12). "Approve" відкриває
 * доступ і шле лист "Your agency account is approved"; "Ask for more info"
 * повертає форму заявнику з нотаткою; "Reject" з причиною.
 */

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

const ERRORS: Record<string, string> = {
  not_admin: "Only admins can do this.",
  not_found: "Application not found.",
  not_open: "This application was already decided.",
  note_required: "Write a note: the applicant sees it.",
  note_too_long: `Keep the note under ${REVIEW_NOTE_MAX} characters.`,
  invalid_decision: "Choose Approve, Ask for more info or Reject.",
};

const DONE: Record<string, string> = {
  approved: "Approved. The agency has access now.",
  needs_info: "Sent back to the applicant with your note.",
  rejected: "Rejected.",
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const TEXTAREA =
  "block w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none";

function NoteForm({ app, decision, label, submit, variant }: { app: AdminApplication; decision: "needs_info" | "reject"; label: string; submit: string; variant: "outline" | "destructive" }) {
  const id = `${decision}-${app.id}`;
  return (
    <details className="text-sm">
      <summary className="inline-flex min-h-11 cursor-pointer items-center text-brand">{submit}</summary>
      <form action={reviewApplicationAction} className="mt-2 grid gap-2 sm:max-w-md">
        <input type="hidden" name="application_id" value={app.id} />
        <input type="hidden" name="decision" value={decision} />
        <label htmlFor={id} className="text-ink-muted">
          {label}
        </label>
        <textarea id={id} name="note" required rows={3} maxLength={REVIEW_NOTE_MAX} className={TEXTAREA} />
        <Button type="submit" variant={variant} className="h-10 w-fit px-3">
          {submit}
        </Button>
      </form>
    </details>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[11rem_1fr] sm:gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="break-words whitespace-pre-line text-ink">{children}</dd>
    </div>
  );
}

export default async function AgencyApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  if (!(await currentAdmin())) notFound();
  const params = await searchParams;
  const done = first(params.done);
  const error = first(params.error);
  const emailed = first(params.emailed);
  const apps = await listApplicationsForAdmin(db());

  return (
    <section className="mx-auto grid max-w-4xl gap-6 px-4 py-10 sm:px-6 sm:py-14">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Agency applications</h1>

      {done && DONE[done] ? (
        <p role="status" className="rounded-md border border-line bg-brand-soft px-4 py-3 text-sm text-ink">
          {DONE[done]}
          {emailed === "0" ? " Email not sent: mail is not set up yet, so tell the agency yourself." : " The owners got an email."}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-ink">
          {ERRORS[error] ?? "Something went wrong."}
        </p>
      ) : null}

      {apps.length === 0 ? (
        <p className="text-ink-muted">No applications waiting.</p>
      ) : (
        <ul className="grid gap-4">
          {apps.map((app) => (
            <li key={app.id} className="grid gap-4 rounded-lg border border-line bg-surface p-4 sm:p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-lg font-semibold">{app.companyName}</h2>
                <span className="font-mono text-xs text-ink-muted">
                  {app.status === "needs_info" ? "Waiting for the agency" : "New"}, sent {DATE.format(fromSqlTime(app.updatedAt))}
                </span>
              </div>
              <dl className="grid gap-2 text-sm">
                <Detail label="Contact">
                  {app.contactName}, {app.contactEmail}
                </Detail>
                <Detail label="Signed in as">{app.applicantEmail ?? "Telegram account (no email)"}</Detail>
                <Detail label="Website">
                  {app.website}
                  {app.domain ? ` (domain ${app.domain} ${app.domainVerified ? "verified by email" : "not verified"})` : ""}
                </Detail>
                <Detail label="Country">{countryName(app.country) || app.country}</Detail>
                <Detail label="Recruits for">{app.clientsText}</Detail>
                <Detail label="Hires per quarter">{app.volumeText ?? "Not given"}</Detail>
                <Detail label="Use of profiles">{app.dataUseText}</Detail>
                {app.reviewerNote ? <Detail label="Our last note">{app.reviewerNote}</Detail> : null}
              </dl>
              <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
                <form action={reviewApplicationAction}>
                  <input type="hidden" name="application_id" value={app.id} />
                  <input type="hidden" name="decision" value="approve" />
                  <input type="hidden" name="note" value="" />
                  <Button type="submit" className="h-11 px-4">
                    Approve
                  </Button>
                </form>
                <NoteForm app={app} decision="needs_info" label="What should the agency add? They see this." submit="Ask for more info" variant="outline" />
                <NoteForm app={app} decision="reject" label="Reason. The agency sees this." submit="Reject" variant="destructive" />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
