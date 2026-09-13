import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AdminNav } from "@/components/admin-nav";
import { BOARD, TABLE, TD_TIGHT, TH_TIGHT, TR } from "@/components/board";
import { Button } from "@/components/ui/button";
import { ADMIN_JOBS_LIMIT, listAdminJobs, type AdminJobError, type AdminJobRow } from "@/lib/admin/jobs";
import { currentAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { fromSqlTime } from "@/lib/time";
import { hideJobAction, unhideJobAction } from "./actions";

export const metadata: Metadata = { title: "Company jobs", robots: { index: false } };

/**
 * Адмінка: відкриті вакансії компаній і приховані (специфікація CRM 12, "Jobs": "Hide" /
 * "Unhide"). Вакансії публікуються одразу; прихована зникає з добірок, search_jobs,
 * публічної сторінки й черги X, компанія бачить "Hidden by NextCryptoJob".
 */

const ERRORS: Record<AdminJobError, string> = {
  not_admin: "Only admins can do this.",
  not_found: "This job was not found, or it is already in that state.",
  bad_url: "Paste the https://x.com/.../status/... link of the post.",
};

const DONE: Record<string, string> = { hidden: "is hidden", unhidden: "is visible again" };

const WHEN = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function state(row: AdminJobRow): string {
  if (row.hiddenAt) return `Hidden since ${WHEN.format(fromSqlTime(row.hiddenAt))}`;
  if (row.live) return "Live";
  if (row.expiresAt && fromSqlTime(row.expiresAt).getTime() <= Date.now()) return "Expired";
  return "Not live: no active subscription";
}

const TD = TD_TIGHT;

export default async function AdminJobsPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  if (!(await currentAdmin())) notFound();
  const params = await searchParams;
  const rows = await listAdminJobs(db());
  const error = first(params.error);
  const done = first(params.done);

  return (
    <section className="mx-auto px-[clamp(16px,4vw,56px)] pt-8 pb-20 sm:pt-12 max-w-6xl">
      <AdminNav current="/admin/jobs" />
      <h1 className="display text-title">Company jobs</h1>
      <p className="mt-2 max-w-prose text-sm text-ink-muted">
        Jobs go live as soon as a subscribed company publishes them. Hide a job to take it out of digests, the job search, its
        public page and the X queue at once. The company sees &ldquo;Hidden by NextCryptoJob&rdquo;.
      </p>

      {error && error in ERRORS ? (
        <p role="alert" className="mt-6 rounded-lg border border-destructive/50 bg-surface px-4 py-3 text-sm text-ink">
          {ERRORS[error as AdminJobError]}
        </p>
      ) : null}
      {done && done in DONE ? (
        <p role="status" className="mt-6 rounded-lg border border-ink bg-surface px-4 py-3 text-sm text-ink">
          Job {first(params.job)} {DONE[done]}.
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="mt-8 rounded-xl border border-dashed border-line-strong p-6 text-ink-muted">No open or hidden jobs.</p>
      ) : (
        <div className="mt-8 grid gap-3">
          <div className={BOARD}>
            <table className={`${TABLE} min-w-[760px]`}>
              <thead>
                <tr>
                  <th scope="col" className={TH_TIGHT}>Job</th>
                  <th scope="col" className={TH_TIGHT}>Company</th>
                  <th scope="col" className={TH_TIGHT}>State</th>
                  <th scope="col" className={`${TH_TIGHT} text-right`}>Shown / clicks</th>
                  <th scope="col" className={TH_TIGHT}>Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className={TR} data-job={row.id}>
                    <td className={TD}>
                      {row.live ? (
                        <a href={`/jobs/${row.id}`} target="_blank" rel="noopener noreferrer" className="font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand">
                          {row.title}
                        </a>
                      ) : (
                        <span className="font-semibold text-ink">{row.title}</span>
                      )}
                      <div className="font-mono text-xs text-ink-muted">{row.id}</div>
                    </td>
                    <td className={TD}>
                      <div className="text-ink">{row.companyName}</div>
                      <div className="font-mono text-xs text-ink-muted">{row.companyId}</div>
                    </td>
                    <td className={`${TD} ${row.live ? "font-semibold text-ink" : "text-ink-muted"}`}>{state(row)}</td>
                    <td className={`${TD} text-right tabular-nums`}>
                      {row.digestShown} / {row.applyClicks}
                    </td>
                    <td className={TD}>
                      <form action={row.hiddenAt ? unhideJobAction : hideJobAction}>
                        <input type="hidden" name="job_id" value={row.id} />
                        <Button type="submit" variant={row.hiddenAt ? "outline" : "destructive"} className="h-11 px-3">
                          {row.hiddenAt ? "Unhide" : "Hide"}
                        </Button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length === ADMIN_JOBS_LIMIT ? <p className="text-xs text-ink-muted">Showing the newest {ADMIN_JOBS_LIMIT}.</p> : null}
        </div>
      )}
    </section>
  );
}
