import type { Metadata } from "next";
import Link from "next/link";
import { doneText, errorText, first } from "@/components/crm/messages";
import { CARD, EmptyState, LINK, NoAccess, Notice, PageTitle } from "@/components/crm/ui";
import { buttonVariants } from "@/components/ui/button";
import { readAction } from "@/lib/crm/actions";
import { hiddenJobIds, notLiveReason, openJobCount, openJobLimit, placeText, type JobList } from "@/lib/crm/jobs";
import { cn } from "@/lib/utils";
import { crmPage } from "../crm";
import { CloseJobForm, StatusChip, xPostText } from "./parts";

export const metadata: Metadata = { title: "Jobs", robots: { index: false } };

/**
 * Вакансії компанії (специфікація 10.2): стан, "Live" / "Not live: {reason}", покази в
 * добірках, переходи "Apply", стан посту в X. Список через реєстр (list_jobs), закриття
 * через close_job. Без підписки лише читання.
 */
export default async function JobsPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const { ctx, company } = await crmPage("jobs");
  const params = await searchParams;
  const done = doneText(first(params.done));
  const error = errorText(first(params.error));
  const canWrite = company.access === "subscription";

  if (company.access === "none") {
    return (
      <div className="mx-auto grid max-w-3xl gap-6 px-4 pt-8 pb-20 sm:px-6 sm:pt-12">
        <PageTitle>Jobs</PageTitle>
        <NoAccess />
      </div>
    );
  }

  const cursor = first(params.cursor);
  const [list, hidden, openNow] = await Promise.all([
    readAction("list_jobs", { limit: 50, ...(cursor ? { cursor } : {}) }, ctx) as Promise<JobList>,
    hiddenJobIds(ctx),
    openJobCount(ctx),
  ]);
  const limit = openJobLimit(company);

  return (
    <div className="mx-auto grid max-w-3xl gap-6 px-4 pt-8 pb-20 sm:px-6 sm:pt-12">
      <PageTitle aside={limit ? `${openNow} of ${limit} open` : undefined}>Jobs</PageTitle>
      {done ? <Notice tone="success">{done}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!canWrite ? <Notice tone="info">Read-only: no active subscription. Your jobs are not shown to candidates.</Notice> : null}
      {canWrite ? (
        <div>
          <Link href="/company/jobs/new" className={cn(buttonVariants(), "h-11 px-5 text-base")}>
            New job
          </Link>
        </div>
      ) : null}

      {list.data.length === 0 ? (
        <EmptyState title="No jobs yet. Jobs you publish appear in daily digests of matching candidates." />
      ) : (
        <ul className="grid gap-3">
          {list.data.map((job) => {
            const reason = notLiveReason(job, { hidden: hidden.has(job.job_id), access: company.access, now: ctx.now });
            const x = xPostText(job.x_post);
            const place = placeText(job.work_mode, job.city ?? null);
            return (
              <li key={job.job_id} className={`${CARD} grid gap-3 p-4`} data-job={job.job_id}>
                <div className="grid gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="min-w-0 font-semibold tracking-tight break-words">
                      <Link href={`/company/jobs/${job.job_id}`} className="hover:text-brand hover:underline">
                        {job.title}
                      </Link>
                    </h2>
                    <StatusChip job={job} />
                  </div>
                  <p className="text-sm text-ink-muted">{[place, reason ? `Not live: ${reason}` : null].filter(Boolean).join(" · ")}</p>
                  {job.status !== "draft" ? (
                    <p className="text-sm text-ink-muted">
                      {job.stats.digest_shown} shown in digests, {job.stats.apply_clicks} {job.stats.apply_clicks === 1 ? "click" : "clicks"} on Apply
                    </p>
                  ) : null}
                  {x ? (
                    <p className="text-xs text-ink-muted">
                      {x}
                      {job.x_post.url ? (
                        <>
                          {" "}
                          <a href={job.x_post.url} target="_blank" rel="noopener noreferrer" className={LINK}>
                            View post
                          </a>
                        </>
                      ) : null}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/company/jobs/${job.job_id}`}
                    prefetch={false}
                    className={cn(buttonVariants({ variant: "outline" }), "h-11 px-4 text-sm")}
                  >
                    {canWrite ? "Edit" : "View"}
                  </Link>
                  {job.public_url ? (
                    <a href={job.public_url} target="_blank" rel="noopener noreferrer" className={cn(LINK, "px-2 text-sm")}>
                      Public page
                    </a>
                  ) : null}
                  {canWrite && job.status !== "closed" ? <CloseJobForm companyId={company.id} job={job} back="list" /> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {list.next_cursor ? (
        <p>
          <Link href={`/company/jobs?cursor=${encodeURIComponent(list.next_cursor)}`} className={LINK}>
            Older jobs
          </Link>
        </p>
      ) : null}
    </div>
  );
}
