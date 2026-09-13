import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { HINT } from "@/components/form/styles";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { dayLabel } from "@/lib/digest/format";
import { loadJobsPage, type SentDigest, type SentJob } from "@/lib/digest/history";
import { jobsDb } from "@/lib/jobs-db";
import { emptyState, scheduleLine } from "./empty-state";

export const metadata: Metadata = { title: "Your jobs", robots: { index: false } };

// Текст із чужих дощок буває одним довгим словом: переносимо будь-де, щоб 390 px не роз'їхались.
const WRAP = "min-w-0 wrap-anywhere";

function JobItem({ job }: { job: SentJob }) {
  const d = job.details;
  if (!d) {
    return (
      <li className="grid gap-1 rounded-xl border border-line bg-surface p-4 sm:p-5">
        <p className="text-base font-medium text-ink-muted">
          {job.state === "unavailable" ? "Job details are not available right now." : "This job is no longer listed."}
        </p>
        {job.why ? <p className={`${HINT} ${WRAP}`}>{job.why}</p> : null}
      </li>
    );
  }
  const meta = [d.company, d.location, d.salary].filter(Boolean).join(" · ");
  const titleClass = `text-base font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand ${WRAP}`;
  return (
    <li className="grid gap-1.5 rounded-xl border border-line bg-surface p-4 sm:p-5">
      <h3 className={`font-sans text-base font-semibold ${WRAP}`}>
        {d.url === null ? (
          <span className={WRAP}>{d.title}</span>
        ) : d.url.startsWith("/") ? (
          // Вакансія компанії: її сторінка на сайті, у тій самій вкладці.
          <Link href={d.url} prefetch={false} className={titleClass}>
            {d.title}
          </Link>
        ) : d.url.startsWith("mailto:") ? (
          <a href={d.url} className={titleClass}>
            {d.title}
          </a>
        ) : (
          <a href={d.url} target="_blank" rel="noopener noreferrer nofollow" className={titleClass}>
            {d.title}
          </a>
        )}
      </h3>
      {meta ? <p className={`text-sm text-ink-muted ${WRAP}`}>{meta}</p> : null}
      {job.why ? <p className={`text-sm text-ink ${WRAP}`}>{job.why}</p> : null}
      {d.postedBy ? <p className={`text-xs text-ink-muted ${WRAP}`}>Posted by {d.postedBy} on NextCryptoJob</p> : null}
    </li>
  );
}

function Digest({ digest }: { digest: SentDigest }) {
  const n = digest.jobs.length;
  const by = digest.channel === "telegram" ? "in Telegram" : digest.channel === "email" ? "by email" : null;
  const id = `digest-${digest.digestId}`;
  return (
    <section aria-labelledby={id} className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id={id} className="display text-[1.75rem] leading-none">
          {dayLabel(digest.localDate)}
        </h2>
        <p className="text-sm text-ink-muted">
          {n} job{n === 1 ? "" : "s"}
          {by ? `, ${by}` : ""}
        </p>
      </div>
      <ol className="grid gap-3">
        {digest.jobs.map((job) => (
          <JobItem key={job.ref} job={job} />
        ))}
      </ol>
    </section>
  );
}

/** Вакансії, які добірка вже надіслала людині, за останні 14 днів, новіші зверху. */
export default async function JobsPage() {
  const user = await requireUser();
  const page = await loadJobsPage(db(), jobsDb(), user.id);
  if (!page) redirect("/login");
  const { setup, digests, historyError } = page;
  const empty = digests.length === 0 && !historyError ? emptyState(setup) : null;

  return (
    <div className="mx-auto grid max-w-3xl gap-6 px-[clamp(16px,4vw,56px)] pt-8 pb-20 sm:pt-14">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="display text-title">Your jobs</h1>
        <Link
          href="/settings"
          className="-mr-2 inline-flex min-h-11 items-center px-2 text-sm font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand"
        >
          Daily jobs settings
        </Link>
      </div>

      {historyError ? (
        <div role="alert" className="grid gap-1 rounded-xl border border-line bg-surface p-4 sm:p-5">
          <p className="font-medium text-ink">We could not load your jobs right now.</p>
          <p className={HINT}>Nothing is lost. Try again in a minute.</p>
        </div>
      ) : empty ? (
        <div className="grid gap-3 rounded-xl border border-line bg-surface p-4 sm:p-5">
          <div className="grid gap-1">
            <p className="font-medium text-ink">{empty.title}</p>
            <p className={HINT}>{empty.body}</p>
          </div>
          <Button asChild size="lg" className="w-full sm:w-fit">
            <Link href={empty.href}>{empty.cta}</Link>
          </Button>
        </div>
      ) : (
        <>
          <p className={HINT}>{scheduleLine(setup)}</p>
          {digests.map((digest) => (
            <Digest key={digest.digestId} digest={digest} />
          ))}
        </>
      )}
    </div>
  );
}
