import { HINT } from "@/components/form/styles";
import { JobCard } from "@/components/jobs/job-card";
import { SaveButton } from "@/components/jobs/save-button";
import type { SavedJob } from "@/lib/digest/history";

const WRAP = "min-w-0 wrap-anywhere";

/**
 * Збережені вакансії окремим списком (власник 16.09, j1). Звідки б людина не зберегла (добірка,
 * вибір «зараз», сторінка вакансії), усе тут, новіші зверху. Вакансія, якої вже немає, лишається
 * рядком з кнопкою прибрати, щоб список не мінявся сам собою.
 */
export function SavedList({ jobs }: { jobs: SavedJob[] | null }) {
  if (jobs === null) {
    return (
      <div role="status" className="grid gap-1 rounded-3xl bg-soft p-5 sm:p-6">
        <p className="font-medium text-ink">We could not load your saved jobs right now.</p>
        <p className={HINT}>Nothing is lost. Try again in a minute.</p>
      </div>
    );
  }
  return (
    <ol className="grid gap-3">
      {jobs.map((job) =>
        job.details ? (
          <JobCard key={job.ref} job={job.details} compact jobRef={job.ref} saved />
        ) : (
          <li
            key={job.ref}
            className="flex flex-wrap items-center justify-between gap-3 rounded-3xl border-[1.5px] border-dashed border-line-strong p-5 sm:p-6"
          >
            <p className={`text-base font-medium text-ink-muted ${WRAP}`}>
              {job.state === "unavailable" ? "Job details are not available right now." : "This job is no longer listed."}
            </p>
            <SaveButton jobRef={job.ref} initialSaved compact />
          </li>
        ),
      )}
    </ol>
  );
}
