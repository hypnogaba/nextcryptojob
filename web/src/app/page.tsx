import type { Metadata } from "next";
import Link from "next/link";
import { CardFront } from "@/components/card/card-front";
import { Button } from "@/components/ui/button";
import { exampleFace } from "@/lib/card/example";
import { appEnv, db } from "@/lib/db";
import { countLine, todayJobs, type ShownJob, type TodayJobs } from "@/lib/jobs/instant";
import { jobsDb } from "@/lib/jobs-db";

export const metadata: Metadata = {
  description:
    "Answer a short brief and get a few crypto jobs that fit you, right away and every day by Telegram or email. Free.",
};

// Живий список з пулу вакансій: сторінку рендеримо на запит (кеш у пам'яті ізолята, lib/jobs/instant.ts),
// бо статична збірка не бачить бази, а ISR цей кеш OpenNext не вміє (open-next.config.ts).
export const dynamic = "force-dynamic";

const WRAP = "mx-auto max-w-[1240px] px-[clamp(16px,4vw,56px)]";
const LINK =
  "font-semibold text-ink underline decoration-line-strong decoration-1 underline-offset-4 hover:decoration-brand";

const STEPS = [
  {
    title: "Tell us what you want",
    body: "Your roles, remote or a city, the lowest salary you would take, and a few words of your own. About 2 minutes.",
  },
  {
    title: "We match you",
    body: "You see the jobs that fit right away, one per company, with a line on why each one matches.",
  },
  {
    title: "Get a few jobs every day",
    body: "Up to 5 new jobs a day by Telegram or email, at the hour you pick. Pause any time.",
  },
] as const;

function PreviewJob({ job, n }: { job: ShownJob; n: number }) {
  const meta = [job.company, job.location, job.salary].filter(Boolean).join(" · ");
  const title = "font-semibold text-ink underline decoration-line-strong decoration-1 underline-offset-4 hover:decoration-brand";
  return (
    <li className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3 border-b border-line px-4 py-3.5 last:border-b-0 sm:px-5">
      <span aria-hidden className="font-display text-[1.375rem] leading-[1.1] font-black text-ink-muted">
        {n}
      </span>
      <div className="grid min-w-0 gap-0.5 wrap-anywhere">
        {job.url === null ? (
          <span className="font-semibold text-ink">{job.title}</span>
        ) : job.url.startsWith("/") ? (
          <Link href={job.url} prefetch={false} className={title}>
            {job.title}
          </Link>
        ) : (
          <a href={job.url} target="_blank" rel="noopener noreferrer nofollow" className={title}>
            {job.title}
          </a>
        )}
        {meta ? <p className="text-sm text-ink-muted">{meta}</p> : null}
      </div>
    </li>
  );
}

/** «Today's jobs»: приклад добірки з живого пулу. Без бази сторінка однаково відкривається. */
function TodayPanel({ today }: { today: TodayJobs }) {
  const count = countLine(today);
  const shown = today.available && today.jobs.length > 0;
  return (
    <section
      id="today"
      aria-labelledby="today-h"
      className="scroll-mt-6 overflow-hidden rounded-[10px] border-2 border-ink bg-surface shadow-rest"
    >
      <div className="grid gap-1 border-b-2 border-ink px-4 pt-4 pb-3 sm:px-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id="today-h" className="font-display text-[1.75rem] leading-none font-extrabold uppercase">
            Today&apos;s jobs
          </h2>
          <span className="font-display text-[0.8125rem] font-extrabold tracking-[0.08em] text-brand uppercase">
            Example list
          </span>
        </div>
        <p className="text-sm text-ink-muted">
          {shown
            ? "What a daily list looks like for a remote brief from $50k. Yours follows your own brief."
            : "Today's jobs did not load just now. Your brief still works: we show your matches as soon as they load."}
        </p>
      </div>
      {shown ? (
        <ol>
          {today.jobs.map((job, i) => (
            <PreviewJob key={job.ref} job={job} n={i + 1} />
          ))}
        </ol>
      ) : null}
      {count ? <p className="border-t border-line bg-sleeve px-4 py-3 text-sm text-ink-muted sm:px-5">{count}</p> : null}
    </section>
  );
}

export default async function HomePage() {
  const today = await todayJobs({ db, env: safeEnv(), jobs: jobsDb, now: new Date() });
  const face = exampleFace();

  return (
    <>
      <section
        className={`${WRAP} grid items-start gap-10 pt-10 pb-16 sm:pt-16 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:gap-16 lg:pb-24`}
      >
        <div className="lg:pt-6">
          <h1 className="display text-[clamp(3rem,1.5rem+5.4vw,6rem)] leading-[0.88]">Crypto jobs that fit you.</h1>
          <p className="mt-6 max-w-[36ch] text-xl text-ink-muted">
            Answer a short brief and get a few matching crypto jobs right away, then every day by Telegram or email.
            Free.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
            <Button asChild size="lg">
              <Link href="/login">Get my jobs</Link>
            </Button>
            <Link href="#today" className={`inline-flex min-h-11 items-center ${LINK}`}>
              See today&apos;s jobs
            </Link>
          </div>
        </div>
        <TodayPanel today={today} />
      </section>

      <section aria-labelledby="how-h" className="bg-sleeve py-16 sm:py-24">
        <div className={WRAP}>
          <h2 id="how-h" className="display text-section">
            How it works
          </h2>
          <ol className="mt-10 grid gap-x-10 gap-y-10 md:grid-cols-3">
            {STEPS.map((step, i) => (
              <li key={step.title} className="grid content-start gap-3 border-t-2 border-ink pt-4">
                <span aria-hidden className="font-display text-[4rem] leading-[0.8] font-black">
                  {i + 1}
                </span>
                <h3 className="font-sans text-lg font-semibold text-ink">{step.title}</h3>
                <p className="max-w-[40ch] text-ink-muted">{step.body}</p>
              </li>
            ))}
          </ol>
          <div className="mt-12">
            <Button asChild size="lg">
              <Link href="/login">Get my jobs</Link>
            </Button>
          </div>
        </div>
      </section>

      <section aria-labelledby="standout-h" className={`${WRAP} py-16 sm:py-20`}>
        <div className="grid items-center gap-6 sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-10">
          <div className="ncj-card w-[112px] rotate-[-3deg] sm:w-[132px]">
            <CardFront face={face} />
          </div>
          <div className="grid max-w-[60ch] gap-2">
            <h2 id="standout-h" className="font-sans text-xl font-semibold text-ink">
              Stand out to companies
            </h2>
            <p className="text-ink-muted">
              Optional. Connect X, GitHub or your wallets and we score your public work for one of ten crypto roles,
              with a card you can share. Companies see it only if you turn that on.
            </p>
            <p>
              <Link href="/scoring" className={`inline-flex min-h-11 items-center ${LINK}`}>
                How scoring works
              </Link>
            </p>
          </div>
        </div>
      </section>

      <div className={`${WRAP} pb-4`}>
        <p className="flex flex-wrap gap-x-8 gap-y-1 border-t border-line pt-5 text-ink-muted">
          <span>
            Hiring?{" "}
            <Link href="/company" className={`inline-flex min-h-11 items-center ${LINK}`}>
              Search scored candidates
            </Link>
          </span>
          <span>
            Building an agent?{" "}
            <Link href="/agents" className={`inline-flex min-h-11 items-center ${LINK}`}>
              Use the API and MCP
            </Link>
          </span>
        </p>
      </div>
    </>
  );
}

/** SITE_URL для посилань на вакансії компаній; без оточення Worker порожньо (посилання відносні). */
function safeEnv(): { SITE_URL?: string } {
  try {
    return { SITE_URL: appEnv().SITE_URL };
  } catch {
    return {};
  }
}
