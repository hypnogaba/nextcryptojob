import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { JobCard } from "@/components/jobs/job-card";
import { HINT } from "@/components/form/styles";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { appEnv, db } from "@/lib/db";
import { dayLabel } from "@/lib/digest/format";
import { type DigestSetup, loadJobsPage, type SentDigest, type SentJob } from "@/lib/digest/history";
import { instantMatches, type InstantMatches } from "@/lib/jobs/instant";
import { jobsDb } from "@/lib/jobs-db";
import { briefDone, type SavedStep } from "@/lib/onboarding/steps";
import { checkedLine, emptyState, noMatch, scheduleLine, whenLabel } from "./empty-state";

export const metadata: Metadata = { title: "Your jobs", robots: { index: false } };

const WRAP = "min-w-0 wrap-anywhere";
const TEXT_LINK =
  "inline-flex min-h-11 items-center text-sm font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand";
const H2 = "display text-[1.75rem] leading-none sm:text-[2rem]";
const PANEL = "grid gap-3 rounded-xl border border-line bg-surface p-4 sm:p-5";

function SentItem({ job }: { job: SentJob }) {
  if (!job.details) {
    return (
      <li className="grid gap-1 rounded-xl border border-dashed border-line-strong p-4 sm:p-5">
        <p className="text-base font-medium text-ink-muted">
          {job.state === "unavailable" ? "Job details are not available right now." : "This job is no longer listed."}
        </p>
        {job.why ? <p className={`${HINT} ${WRAP}`}>{job.why}</p> : null}
      </li>
    );
  }
  return <JobCard job={job.details} why={job.why} compact />;
}

function Digest({ digest }: { digest: SentDigest }) {
  const n = digest.jobs.length;
  const by = digest.channel === "telegram" ? "in Telegram" : digest.channel === "email" ? "by email" : null;
  const id = `digest-${digest.digestId}`;
  return (
    <section aria-labelledby={id} className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-line pb-2">
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

/** Вибір «зараз»: п'ять найкращих для анкети людини тими самими правилами, що в добірці. */
function JobsNow({ now }: { now: InstantMatches }) {
  if (now.state === "ok") {
    return (
      <ol className="grid gap-4">
        {now.jobs.map((j, i) => (
          <JobCard key={j.ref} job={j} reasons={j.reasons} note={j.note} rank={i + 1} />
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

/**
 * «Improve your matches»: що міняє підбір (анкета) і що додає причин (X, гаманці, GitHub дають бал
 * за роль, а бал стає однією з причин під вакансією). Без анкети нема чого покращувати.
 */
function Improve({ step }: { step: SavedStep }) {
  if (!briefDone(step)) return null;
  const standoutDone = step === "done";
  return (
    <section aria-labelledby="improve-h" className="grid gap-4 rounded-xl border-2 border-ink bg-surface p-5">
      <div className="grid gap-1.5">
        <h2 id="improve-h" className="font-sans text-lg leading-snug font-semibold text-ink">
          Not quite right? Improve your matches
        </h2>
        <p className={HINT}>
          We pick from what you tell us: what you want in your own words, your roles, where you work and your minimum
          pay. The more you tell us, the better the five fit. Your list updates as soon as you save.
        </p>
      </div>
      <div className="grid gap-1">
        <Button asChild size="lg" className="w-full">
          <Link href="/welcome?step=target">Describe the job you want</Link>
        </Button>
        <div className="flex flex-wrap gap-x-5">
          <Link href="/welcome?step=roles" className={TEXT_LINK}>
            Change roles
          </Link>
          <Link href="/welcome?step=place" className={TEXT_LINK}>
            Remote, city and pay
          </Link>
        </div>
      </div>
      <div className="grid gap-2 border-t border-line pt-4">
        <h3 className="font-sans text-base font-semibold text-ink">Add your public work</h3>
        <p className={HINT}>
          Connect X, wallets or GitHub and we score your work for your roles. A good score shows up in the reasons
          under each job. Companies see you only if you turn that on.
        </p>
        <Button asChild variant="outline" size="lg" className="w-full">
          <Link href={standoutDone ? "/profile" : "/welcome?step=x"}>
            {standoutDone ? "See your score and sources" : "Add X, wallets or GitHub"}
          </Link>
        </Button>
      </div>
    </section>
  );
}

function DailyJobs({ setup }: { setup: DigestSetup }) {
  const line = setup.paused
    ? "Paused. Jobs we sent before stay here."
    : setup.channel
      ? `Up to 5 jobs every day at ${whenLabel(setup)}, ${setup.channel === "telegram" ? "in Telegram" : "by email"}.`
      : "We have nowhere to send them yet. Add an email or connect Telegram.";
  return (
    <section aria-labelledby="daily-h" className="grid gap-1 rounded-xl border border-line bg-surface p-5">
      <h2 id="daily-h" className="font-sans text-base font-semibold text-ink">
        Daily jobs
      </h2>
      <p className={HINT}>{line}</p>
      {setup.channel === "telegram" && !setup.paused ? (
        <p className={HINT}>
          Send <span className="font-mono text-ink">/jobs</span> to the bot to see them again.
        </p>
      ) : null}
      <Link href="/settings" className={`${TEXT_LINK} w-fit`}>
        Time, channel and pause
      </Link>
    </section>
  );
}

/**
 * Вакансії людини: зверху найкращі п'ять «зараз» (живий вибір за анкетою, одразу після неї) з
 * причинами й "Apply", поруч «Improve your matches», нижче надіслане добіркою за 14 днів.
 */
export default async function JobsPage() {
  const user = await requireUser();
  const d = db();
  const page = await loadJobsPage(d, jobsDb(), user.id);
  if (!page) redirect("/login");
  const { setup, digests, historyError } = page;
  // Лише анкета людини з сесії й лише її надіслане: чужого вибір не бачить.
  const now = await instantMatches(
    { db: d, env: appEnv(), jobs: jobsDb, now: new Date() },
    page.brief,
    page.sentRefs,
    page.fit,
  );
  const noHistory = digests.length === 0 && !historyError;
  const empty = noHistory ? emptyState(setup) : null;
  const checked = now.state === "ok" ? checkedLine(now.checked, now.jobs.length) : null;

  return (
    <div className="mx-auto max-w-[1240px] px-[clamp(16px,4vw,56px)] pt-8 pb-20 sm:pt-12">
      <h1 className="display text-title">Your jobs</h1>

      <div className="mt-8 grid items-start gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section aria-labelledby="now-h" className="grid max-w-[760px] gap-5 lg:col-start-1 lg:row-start-1">
          <div className="grid gap-2">
            <h2 id="now-h" className={H2}>
              Your best matches today
            </h2>
            {checked ? (
              <p className="text-base leading-snug text-ink sm:text-lg">
                {checked.lead} <strong className="font-semibold">{checked.tail}</strong>
              </p>
            ) : null}
            {now.state === "ok" ? (
              <p className={HINT}>Picked just now by the same rules as your daily list, one job per company.</p>
            ) : null}
          </div>
          <JobsNow now={now} />
        </section>

        <aside className="grid gap-4 lg:sticky lg:top-6 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <Improve step={page.step} />
          <DailyJobs setup={setup} />
        </aside>

        {setup.hasRoles || !noHistory ? (
          <section aria-labelledby="sent-h" className="grid max-w-[760px] gap-5 lg:col-start-1 lg:row-start-2">
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
                <Link href={empty.href} className={`${TEXT_LINK} w-fit`}>
                  {empty.cta}
                </Link>
              </div>
            ) : (
              <div className="grid gap-8">
                {digests.map((digest) => (
                  <Digest key={digest.digestId} digest={digest} />
                ))}
              </div>
            )}
          </section>
        ) : null}
      </div>
    </div>
  );
}
