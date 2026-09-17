import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AccountShell } from "@/components/account-nav";
import { HINT } from "@/components/form/styles";
import { Button } from "@/components/ui/button";
import { currentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { loadSavedJobs } from "@/lib/digest/history";
import { companyProfiles } from "@/lib/jobs/companies";
import { jobsDb } from "@/lib/jobs-db";
import { SavedList } from "../saved-list";

export const metadata: Metadata = { title: "Saved jobs", robots: { index: false } };

/**
 * Збережені вакансії власною сторінкою (власник 17.09): на /jobs вони стояли третім блоком під
 * вибором «зараз» і надісланим, і сторінка виходила дуже довга. Тепер /jobs показує лише
 * лічильник з посиланням, а весь список живе тут, підпунктом меню під «Your jobs».
 */
export default async function SavedJobsPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const saved = await companyProfiles(jobsDb).then((profiles) => loadSavedJobs(db(), jobsDb(), user.id, profiles));
  const count = saved.refs.size;

  return (
    <AccountShell active="saved" title="Saved jobs" sub="Everything you saved, newest first.">
      <div className="grid max-w-[820px] gap-5">
        <div className="grid gap-1">
          <p className="text-base leading-snug text-ink sm:text-lg">
            {count > 0 ? (
              <>
                You saved <strong className="font-semibold">{count === 1 ? "1 job" : `${count} jobs`}</strong>.
              </>
            ) : (
              "You have not saved a job yet."
            )}
          </p>
          <p className={HINT}>Save or unsave from any job card. Saving never changes your daily list.</p>
        </div>
        {count > 0 ? (
          <SavedList jobs={saved.jobs} />
        ) : (
          <div className="grid gap-3 rounded-3xl bg-soft p-5 sm:p-6">
            <p className="font-medium text-ink">Save a job to keep it here.</p>
            <p className={HINT}>Every job card has a Save button, in your daily list and on the job page.</p>
            <Button asChild size="lg" className="w-full sm:w-fit">
              <Link href="/jobs">See your jobs</Link>
            </Button>
          </div>
        )}
      </div>
    </AccountShell>
  );
}
