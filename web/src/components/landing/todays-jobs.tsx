import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import type { TickerJob, TodaysJobs as Today } from "@/lib/jobs/home-board";
import { ROLE_NAMES } from "@/lib/jobs/roles";

const APPLY =
  "inline-flex h-10 shrink-0 items-center gap-1 rounded-lg bg-brand-soft px-3.5 text-sm font-semibold text-brand transition-colors duration-150 hover:bg-brand hover:text-brand-ink active:translate-y-px motion-reduce:transition-none";

function Apply({ job }: { job: TickerJob }) {
  const label = `Apply: ${job.title} at ${job.company}`;
  const body = (
    <>
      Apply
      <ArrowUpRight aria-hidden className="size-4" strokeWidth={2.25} />
    </>
  );
  // Зовнішня: адреса й rel з lib/jobs/link.ts (web3.career лише "noopener", follow).
  return job.external ? (
    <a href={job.href} target="_blank" rel={job.rel ?? undefined} aria-label={label} className={APPLY}>
      {body}
    </a>
  ) : (
    <Link href={job.href} prefetch={false} aria-label={label} className={APPLY}>
      {body}
    </Link>
  );
}

/**
 * Приклад щоденного листа в герої головної: п'ять живих вакансій з пулу (lib/jobs/home-board.ts,
 * todaysJobs) з кнопкою Apply, як у справжній добірці. Позначка EXAMPLE і підпис кажуть, для кого
 * цей приклад. Без бази вакансій замість рядків один рядок пояснення, анкета працює й так.
 * id="today": сюди веде «Jobs» у шапці для гостя.
 */
export function TodaysJobs({ today, date }: { today: Today | null; date: string }) {
  const jobs = today?.jobs ?? [];
  const who = today?.role
    ? `Live jobs for ${/^[aeiou]/i.test(ROLE_NAMES[today.role]) ? "an" : "a"} ${ROLE_NAMES[today.role].toLowerCase()} who wants remote work. Yours follow your brief.`
    : "A few of today's live jobs. Yours follow your brief.";

  return (
    <section
      id="today"
      aria-labelledby="today-h"
      className="scroll-mt-6 overflow-hidden rounded-xl border border-line bg-surface shadow-rest"
    >
      <header className="flex items-start justify-between gap-4 border-b border-line px-4 py-3.5 sm:px-5">
        <div className="grid gap-0.5">
          <h2 id="today-h" className="font-sans text-[1.0625rem] leading-tight font-semibold">
            Your 5 for today
          </h2>
          <p className="text-sm text-ink-muted">{date}, by Telegram or email</p>
        </div>
        <span className="mt-0.5 rounded-[3px] bg-brand px-1.5 font-display text-xs leading-[1.5] font-extrabold tracking-[0.1em] text-brand-ink">
          EXAMPLE
        </span>
      </header>
      {jobs.length > 0 ? (
        <ol className="divide-y divide-line">
          {jobs.map((job) => (
            <li key={job.ref} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-3 sm:px-5">
              <div className="grid min-w-0 gap-0.5">
                <p className="line-clamp-2 text-[0.9375rem] leading-snug font-semibold text-ink">{job.title}</p>
                <p className="truncate text-[0.8125rem] text-ink-muted">
                  {job.company}
                  {job.place ? `, ${job.place}` : ""}
                </p>
                <p
                  className={
                    job.estimate
                      ? "text-[0.8125rem] text-ink-muted italic"
                      : "font-display text-[1.0625rem] leading-tight font-extrabold tracking-[0.01em] text-brand tabular-nums"
                  }
                >
                  {job.salary}
                </p>
              </div>
              <Apply job={job} />
            </li>
          ))}
        </ol>
      ) : (
        <p className="px-4 py-6 text-ink-muted sm:px-5">
          Today&apos;s jobs did not load just now. Your brief still works: we show your matches as soon as they load.
        </p>
      )}
      {jobs.length > 0 ? <p className="border-t border-line bg-sleeve px-4 py-3 text-sm text-ink-muted sm:px-5">{who}</p> : null}
    </section>
  );
}
