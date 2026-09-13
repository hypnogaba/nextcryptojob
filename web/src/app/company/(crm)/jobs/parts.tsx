import { SubmitButton } from "@/components/form/submit-button";
import type { Job } from "@/lib/crm/jobs";
import { closeJobAction } from "./actions";

/** Спільне для списку й сторінки вакансії: стан, пост у X, "Close job" з підтвердженням. */

/** Кнопка-розкривачка небезпечної дії (Close job, Delete, Remove): обведена кольором помилки. */
export const DANGER_SUMMARY =
  "inline-flex h-11 cursor-pointer list-none items-center rounded-lg border border-destructive/50 bg-surface px-3 text-sm font-semibold text-destructive hover:bg-destructive/10 [&::-webkit-details-marker]:hidden";

const STATUS_TEXT: Record<Job["status"], string> = { draft: "Draft", open: "Open", closed: "Closed" };

/** Стан вакансії словом: живу видно за рамкою кольору тексту, решту приглушено. */
export function StatusChip({ job }: { job: Pick<Job, "status" | "live"> }) {
  return (
    <span
      className={
        job.live
          ? "inline-flex items-center rounded-[3px] border border-ink px-1.5 py-0.5 text-xs font-semibold text-ink"
          : "inline-flex items-center rounded-[3px] border border-line bg-wash px-1.5 py-0.5 text-xs font-medium text-ink-muted"
      }
    >
      {job.live ? "Live" : STATUS_TEXT[job.status]}
    </span>
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
      <summary className={DANGER_SUMMARY}>
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
