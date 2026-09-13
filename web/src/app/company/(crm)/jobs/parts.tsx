import { SubmitButton } from "@/components/form/submit-button";
import { Chip } from "@/components/crm/ui";
import type { Job } from "@/lib/crm/jobs";
import { closeJobAction } from "./actions";

/** Спільне для списку й сторінки вакансії: стан, пост у X, "Close job" з підтвердженням. */

const STATUS_TEXT: Record<Job["status"], string> = { draft: "Draft", open: "Open", closed: "Closed" };

export function StatusChip({ job }: { job: Pick<Job, "status" | "live"> }) {
  return (
    <Chip className={job.live ? "bg-brand-soft" : undefined}>
      {job.live ? "Live" : STATUS_TEXT[job.status]}
    </Chip>
  );
}

export function xPostText(x: Job["x_post"]): string | null {
  switch (x.state) {
    case "queued":
      return "X post: waiting for our team";
    case "posted":
      return "X post: posted";
    case "skipped":
      return "X post: not posted";
    default:
      return null;
  }
}

export function CloseJobForm({ companyId, job, back }: { companyId: string; job: Pick<Job, "job_id" | "title">; back: "list" | "job" }) {
  return (
    <details className="max-w-full">
      <summary className="inline-flex h-11 cursor-pointer list-none items-center rounded-lg border border-border px-3 text-sm font-medium text-destructive hover:bg-muted [&::-webkit-details-marker]:hidden">
        Close job
      </summary>
      {/* Підтвердження в потоці, не спливне: на 390 px рядок кнопок переноситься, і спливне вилізло б за край. */}
      <form action={closeJobAction} className="mt-2 grid w-72 max-w-full gap-2 rounded-lg border border-line bg-surface p-3">
        <input type="hidden" name="company_id" value={companyId} />
        <input type="hidden" name="job_id" value={job.job_id} />
        <input type="hidden" name="back" value={back} />
        <p className="text-sm break-words text-ink">
          Close &ldquo;{job.title}&rdquo;? It leaves the digests, the job search and the X queue at once.
        </p>
        <SubmitButton variant="destructive" pendingLabel="Closing..." className="h-11 px-3 text-sm">
          Close job
        </SubmitButton>
      </form>
    </details>
  );
}
