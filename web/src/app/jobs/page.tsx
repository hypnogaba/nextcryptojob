import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { HINT } from "@/components/form/styles";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { appEnv, db } from "@/lib/db";
import { dayLabel } from "@/lib/digest/format";
import { loadJobsPage, type JobDetails, type SentDigest, type SentJob } from "@/lib/digest/history";
import { instantMatches, type InstantMatches } from "@/lib/jobs/instant";
import { jobsDb } from "@/lib/jobs-db";
import { briefDone, type SavedStep } from "@/lib/onboarding/steps";
import { emptyState, noMatch, scheduleLine } from "./empty-state";

export const metadata: Metadata = { title: "Your jobs", robots: { index: false } };

// Текст із чужих дощок буває одним довгим словом: переносимо будь-де, щоб 390 px не роз'їхались.
const WRAP = "min-w-0 wrap-anywhere";
const LINK =
  "-mr-2 inline-flex min-h-11 items-center px-2 text-sm font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand";
const H2 = "display text-[1.75rem] leading-none";
const PANEL = "grid gap-3 rounded-xl border border-line bg-surface p-4 sm:p-5";

function JobTitle({ d }: { d: Pick<JobDetails, "title" | "url"> }) {
  const titleClass = `text-base font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand ${WRAP}`;
  if (d.url === null) return <span className={WRAP}>{d.title}</span>;
  // Вакансія компанії: її сторінка на сайті, у тій самій вкладці.
  if (d.url.startsWith("/")) {
    return (
      <Link href={d.url} prefetch={false} className={titleClass}>
        {d.title}
      </Link>
    );
  }
  if (d.url.startsWith("mailto:")) {
    return (
      <a href={d.url} className={titleClass}>
        {d.title}
      </a>
    );
  }
  return (
    <a href={d.url} target="_blank" rel="noopener noreferrer nofollow" className={titleClass}>
      {d.title}
    </a>
  );
}

/** Одна вакансія: назва-посилання, компанія й місце, рядок «чому». */
function JobRow({ d, why }: { d: JobDetails; why: string | null }) {
  const meta = [d.company, d.location, d.salary].filter(Boolean).join(" · ");
  return (
    <li className="grid gap-1.5 rounded-xl border border-line bg-surface p-4 sm:p-5">
      <h3 className={`font-sans text-base font-semibold ${WRAP}`}>
        <JobTitle d={d} />
      </h3>
      {meta ? <p className={`text-sm text-ink-muted ${WRAP}`}>{meta}</p> : null}
      {why ? <p className={`text-sm text-ink ${WRAP}`}>{why}</p> : null}
      {d.postedBy ? <p className={`text-xs text-ink-muted ${WRAP}`}>Posted by {d.postedBy} on NextCryptoJob</p> : null}
    </li>
  );
}

function SentItem({ job }: { job: SentJob }) {
  if (!job.details) {
    return (
      <li className="grid gap-1 rounded-xl border border-line bg-surface p-4 sm:p-5">
        <p className="text-base font-medium text-ink-muted">
          {job.state === "unavailable" ? "Job details are not available right now." : "This job is no longer listed."}
        </p>
        {job.why ? <p className={`${HINT} ${WRAP}`}>{job.why}</p> : null}
      </li>
    );
  }
  return <JobRow d={job.details} why={job.why} />;
}

function Digest({ digest }: { digest: SentDigest }) {
  const n = digest.jobs.length;
  const by = digest.channel === "telegram" ? "in Telegram" : digest.channel === "email" ? "by email" : null;
  const id = `digest-${digest.digestId}`;
  return (
    <section aria-labelledby={id} className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 id={id} className="font-display text-[1.375rem] leading-none font-extrabold uppercase">
          {dayLabel(digest.localDate)}
        </h3>
        <p className="text-sm text-ink-muted">
          {n} job{n === 1 ? "" : "s"}
          {by ? `, ${by}` : ""}
        </p>
      </div>
      <ol className="grid gap-3">
        {digest.jobs.map((job) => (
          <SentItem key={job.ref} job={job} />
        ))}
      </ol>
    </section>
  );
}

/** «Jobs for you now»: вибір для анкети людини тими самими правилами, що в добірці. */
function JobsNow({ now }: { now: InstantMatches }) {
  if (now.state === "ok") {
    return (
      <ol className="grid gap-3">
        {now.jobs.map((j) => (
          <JobRow key={j.ref} d={j} why={j.why} />
        ))}
      </ol>
    );
  }
  if (now.state === "unavailable") {
    return (
      <div role="status" className={PANEL}>
        <p className="font-medium text-ink">We could not load live jobs right now.</p>
        <p className={HINT}>Nothing is lost. Try again in a minute.</p>
      </div>
    );
  }
  const empty = noMatch(now.reason);
  return (
    <div className={PANEL}>
      <div className="grid gap-1">
        <p className="font-medium text-ink">{empty.title}</p>
        <p className={HINT}>{empty.body}</p>
      </div>
      <Button asChild size="lg" className="w-full sm:w-fit">
        <Link href={empty.href}>{empty.cta}</Link>
      </Button>
    </div>
  );
}

/** Після анкети: необов'язкові кроки, щоб компанії могли знайти людину. */
function StandOut({ step }: { step: SavedStep }) {
  if (!briefDone(step) || step === "done") return null;
  return (
    <section aria-labelledby="standout-h" className="grid gap-3 rounded-xl border-2 border-ink bg-surface p-4 sm:p-5">
      <h2 id="standout-h" className="font-sans text-lg font-semibold text-ink">
        Stand out to companies
      </h2>
      <p className={HINT}>
        Optional. Add X, wallets or GitHub and we score your public work for your roles. Companies see you only if you
        turn that on.
      </p>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <Button asChild size="lg" variant="outline" className="w-full sm:w-fit">
          <Link href="/welcome">Stand out</Link>
        </Button>
        <Link href="/scoring" className={`${LINK} mr-0`}>
          How scoring works
        </Link>
      </div>
    </section>
  );
}

/**
 * Вакансії людини: зверху «Jobs for you now» (живий вибір за анкетою, одразу після неї),
 * нижче те, що добірка вже надіслала за 14 днів, новіші зверху.
 */
export default async function JobsPage() {
  const user = await requireUser();
  const d = db();
  const page = await loadJobsPage(d, jobsDb(), user.id);
  if (!page) redirect("/login");
  const { setup, digests, historyError } = page;
  // Лише анкета людини з сесії й лише її надіслане: чужого вибір не бачить.
  const now = await instantMatches({ db: d, env: appEnv(), jobs: jobsDb, now: new Date() }, page.brief, page.sentRefs);
  const noHistory = digests.length === 0 && !historyError;
  const empty = noHistory ? emptyState(setup) : null;

  return (
    <div className="mx-auto grid max-w-3xl gap-10 px-[clamp(16px,4vw,56px)] pt-8 pb-20 sm:pt-14">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="display text-title">Your jobs</h1>
        <div className="flex flex-wrap gap-x-4">
          <Link href="/welcome?step=target" className={LINK}>
            Edit your brief
          </Link>
          <Link href="/settings" className={LINK}>
            Daily jobs settings
          </Link>
        </div>
      </div>

      <section aria-labelledby="now-h" className="grid gap-4">
        <div className="grid gap-1">
          <h2 id="now-h" className={H2}>
            Jobs for you now
          </h2>
          {now.state === "ok" ? (
            <p className={HINT}>
              Picked just now from today&apos;s live jobs, by the same rules as your daily list. One job per company.
            </p>
          ) : null}
        </div>
        <JobsNow now={now} />
      </section>

      <StandOut step={page.step} />

      {setup.hasRoles || !noHistory ? (
        <section aria-labelledby="sent-h" className="grid gap-4">
          <div className="grid gap-1">
            <h2 id="sent-h" className={H2}>
              Sent to you
            </h2>
            {!noHistory && !historyError ? <p className={HINT}>{scheduleLine(setup)}</p> : null}
          </div>
          {historyError ? (
            <div role="alert" className={PANEL}>
              <p className="font-medium text-ink">We could not load your jobs right now.</p>
              <p className={HINT}>Nothing is lost. Try again in a minute.</p>
            </div>
          ) : empty ? (
            <div className={PANEL}>
              <div className="grid gap-1">
                <p className="font-medium text-ink">{empty.title}</p>
                <p className={HINT}>{empty.body}</p>
              </div>
              <Link href={empty.href} className={`${LINK} -ml-2 w-fit`}>
                {empty.cta}
              </Link>
            </div>
          ) : (
            digests.map((digest) => <Digest key={digest.digestId} digest={digest} />)
          )}
        </section>
      ) : null}
    </div>
  );
}
