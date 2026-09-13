import type { Metadata } from "next";
import Link from "next/link";
import { LINK, NoAccess, Notice, PAGE, PageTitle } from "@/components/crm/ui";
import { COUNTRIES } from "@/lib/crm/countries";
import { EMPTY_JOB_FORM } from "@/lib/crm/job-form";
import { openJobCount, openJobLimit } from "@/lib/crm/jobs";
import { crmPage } from "../../crm";
import { JobForm } from "../job-form";

export const metadata: Metadata = { title: "New job", robots: { index: false } };

/** Нова вакансія: "Publish" одразу (у добірки з наступного дня) або "Save draft". */
export default async function NewJobPage() {
  const { ctx, company } = await crmPage("jobs");
  if (company.access !== "subscription") {
    return (
      <div className={`${PAGE} max-w-3xl`}>
        <PageTitle>New job</PageTitle>
        {company.access === "none" ? <NoAccess /> : <Notice tone="info">Read-only: no active subscription. Subscribe to post jobs.</Notice>}
      </div>
    );
  }
  const limit = openJobLimit(company);
  const open = await openJobCount(ctx);
  return (
    <div className={`${PAGE} max-w-3xl`}>
      <p>
        <Link href="/company/jobs" className={`${LINK} text-sm`}>
          Back to jobs
        </Link>
      </p>
      <PageTitle aside={`${open} of ${limit} open`}>New job</PageTitle>
      <p className="max-w-[65ch] text-sm text-ink-muted">
        A published job goes live at once: it appears in daily digests of candidates with a matching role and place, in the
        public job search and on its own page. It stays live for 60 days.
      </p>
      {open >= limit ? (
        <Notice tone="warning">
          You have {limit} open jobs, the most your plan allows. Close one to publish another, or save this one as a draft.
        </Notice>
      ) : null}
      <JobForm companyId={company.id} mode="new" initial={EMPTY_JOB_FORM} countries={COUNTRIES} xState="none" />
    </div>
  );
}
