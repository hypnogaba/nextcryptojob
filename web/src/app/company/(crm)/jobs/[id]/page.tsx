import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { doneText, errorText, first } from "@/components/crm/messages";
import { CARD, LINK, NoAccess, Notice, PAGE, PageTitle } from "@/components/crm/ui";
import { readAction } from "@/lib/crm/actions";
import { COUNTRIES } from "@/lib/crm/countries";
import { formValuesOf } from "@/lib/crm/job-form";
import { hiddenJobIds, notLiveReason, type Job } from "@/lib/crm/jobs";
import { ActionError } from "@/lib/crm/types";
import { isId } from "@/lib/ids";
import { crmPage } from "../../crm";
import { JobForm, type FormMode } from "../job-form";
import { CloseJobForm, StatusChip, xPostText } from "../parts";

export const metadata: Metadata = { title: "Job", robots: { index: false } };

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * Одна вакансія компанії: стан і причина "Not live", покази й переходи, пост у X,
 * форма зміни (update_job) і "Close job". Чужа чи неіснуюча вакансія: 404.
 */
export default async function JobPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { ctx, company } = await crmPage("jobs");
  const { id } = await params;
  const sp = await searchParams;
  if (company.access === "none") {
    return (
      <div className={`${PAGE} max-w-3xl`}>
        <PageTitle>Job</PageTitle>
        <NoAccess />
      </div>
    );
  }
  if (!isId("job", id)) notFound();
  let job: Job;
  try {
    job = (await readAction("get_job", { job_id: id }, ctx)) as Job;
  } catch (err) {
    if (err instanceof ActionError && err.status === 404) notFound();
    throw err;
  }
  const hidden = (await hiddenJobIds(ctx)).has(job.job_id);
  const reason = notLiveReason(job, { hidden, access: company.access, now: ctx.now });
  const canWrite = company.access === "subscription";
  const expired = job.status === "open" && job.expires_at !== null && Date.parse(job.expires_at) <= ctx.now.getTime();
  const mode: FormMode = job.status === "draft" ? "draft" : job.status === "closed" || expired ? "reopen" : "open";
  const x = xPostText(job.x_post);
  const done = doneText(first(sp.done));
  const error = errorText(first(sp.error));

  return (
    <div className={`${PAGE} max-w-3xl`}>
      <p>
        <Link href="/company/jobs" className={`${LINK} text-sm`}>
          Back to jobs
        </Link>
      </p>
      <PageTitle aside={<StatusChip job={job} />}>
        <span className="break-words">{job.title}</span>
      </PageTitle>
      {done ? <Notice tone="success">{done}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      <section aria-label="Status" className={`${CARD} grid gap-2 p-4 text-sm sm:p-5`}>
        <p className="font-semibold text-ink">{reason ? `Not live: ${reason}` : "Live: in daily digests, the job search and on its public page."}</p>
        {job.published_at ? (
          <p className="text-ink-muted">
            Published {DATE.format(new Date(job.published_at))}
            {job.expires_at && job.status === "open" ? `, ${expired ? "expired" : "live until"} ${DATE.format(new Date(job.expires_at))}` : ""}
          </p>
        ) : null}
        {job.status !== "draft" ? (
          <p className="text-ink-muted">
            {job.stats.digest_shown} shown in digests, {job.stats.apply_clicks} {job.stats.apply_clicks === 1 ? "click" : "clicks"} on Apply.
            We never show who got the job.
          </p>
        ) : null}
        {x ? <p className="text-ink-muted">{x}</p> : null}
        {job.public_url ? (
          <p>
            <a href={job.public_url} target="_blank" rel="noopener noreferrer" className={LINK}>
              Public page
            </a>
          </p>
        ) : null}
        {canWrite && job.status !== "closed" ? (
          <div className="pt-1">
            <CloseJobForm companyId={company.id} job={job} back="job" />
          </div>
        ) : null}
      </section>

      {canWrite ? (
        <JobForm companyId={company.id} jobId={job.job_id} mode={mode} initial={formValuesOf(job)} countries={COUNTRIES} xState={job.x_post.state} />
      ) : (
        <Notice tone="info">Read-only: no active subscription. Subscribe to edit or publish jobs.</Notice>
      )}
    </div>
  );
}
