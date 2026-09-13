import type { CSSProperties } from "react";
import Link from "next/link";
import { TICKER_MIN_TO_SCROLL, type TickerJob } from "@/lib/jobs/home-board";

/** Секунд на одну вакансію: ~60 px/с при середній ширині пункту (~470 px), читається на ходу. */
const SECONDS_PER_JOB = 8;

function Item({ job, copy }: { job: TickerJob; copy: boolean }) {
  const label = [job.title, job.company, job.place, job.salary].filter(Boolean).join(", ");
  const body = (
    <>
      <span className="ncj-ticker-title">{job.title}</span>
      <span className="ncj-ticker-meta">
        {job.company}
        {job.place ? (
          <>
            <span className="ncj-ticker-dot" aria-hidden="true" />
            {job.place}
          </>
        ) : null}
      </span>
      <span className="ncj-ticker-pay">{job.salary}</span>
    </>
  );
  // Копія доріжки лише для безшовного кола: з клавіатури й для читачів екрана її немає.
  const tab = copy ? -1 : undefined;
  return job.external ? (
    <a href={job.href} target="_blank" rel="noopener noreferrer nofollow" aria-label={label} tabIndex={tab} className="ncj-ticker-item">
      {body}
    </a>
  ) : (
    <Link href={job.href} prefetch={false} aria-label={label} tabIndex={tab} className="ncj-ticker-item">
      {body}
    </Link>
  );
}

/**
 * Стрічка живих вакансій із зарплатою. Лише CSS (globals.css, .ncj-ticker): доріжка з двох
 * однакових списків їде на -50% по колу; пауза під курсором і фокусом; з клавіатури стрічка
 * зупиняється й гортається сама до вакансії у фокусі; під prefers-reduced-motion стоїть і
 * гортається пальцем. Другий список aria-hidden, тож список читається один раз.
 * Коротку стрічку (менше TICKER_MIN_TO_SCROLL) не рухаємо: вона не заповнить широкий екран.
 */
export function JobTicker({ jobs }: { jobs: readonly TickerJob[] }) {
  if (jobs.length === 0) return null;
  const moving = jobs.length >= TICKER_MIN_TO_SCROLL;
  const list = (copy: boolean) => (
    <ul className="ncj-ticker-list" aria-hidden={copy ? true : undefined} aria-label={copy ? undefined : "Live jobs with a salary"}>
      {jobs.map((job) => (
        <li key={job.ref}>
          <Item job={job} copy={copy} />
        </li>
      ))}
    </ul>
  );
  return (
    <div className="ncj-ticker" data-moving={moving}>
      <div className="ncj-ticker-track" style={{ "--ticker-dur": `${jobs.length * SECONDS_PER_JOB}s` } as CSSProperties}>
        {list(false)}
        {moving ? list(true) : null}
      </div>
    </div>
  );
}
