import type { CSSProperties } from "react";
import Link from "next/link";
import type { TickerJob } from "@/lib/jobs/home-board";

/** Стільки рядків треба, щоб коло стрічки не показувало дірку у вікні на 5 рядків. */
export const FEED_MIN_TO_ROLL = 7;
/** Секунд на рядок: стрічка йде повільно, як надходження в банківському застосунку. */
const SECONDS_PER_ROW = 5;

function Row({ job, copy }: { job: TickerJob; copy: boolean }) {
  const label = [job.title, job.company, job.place, job.salary, job.via ? `via ${job.via}` : null].filter(Boolean).join(", ");
  const body = (
    <>
      <span className="ncj-feed-av" aria-hidden="true">
        {[...job.company.trim()][0]?.toUpperCase() ?? "?"}
      </span>
      <span className="min-w-0">
        <span className="ncj-feed-t">{job.title}</span>
        <span className="ncj-feed-c">
          {job.company}
          {job.place ? ` · ${job.place}` : ""}
          {/* Джерело названо видимо: цього просять умови web3.career. */}
          {job.via ? ` · via ${job.via}` : ""}
        </span>
      </span>
      <span className={job.estimate ? "ncj-feed-p ncj-feed-est" : "ncj-feed-p"}>{job.estimate ? "Not listed" : job.salary}</span>
    </>
  );
  // Копія лише для безшовного кола: з клавіатури й для читачів екрана її немає.
  const tab = copy ? -1 : undefined;
  // Зовнішня: адреса й rel з lib/jobs/link.ts (web3.career лише "noopener", follow).
  return job.external ? (
    <a href={job.href} target="_blank" rel={job.rel ?? undefined} aria-label={label} tabIndex={tab} className="ncj-feed-row">
      {body}
    </a>
  ) : (
    <Link href={job.href} prefetch={false} aria-label={label} tabIndex={tab} className="ncj-feed-row">
      {body}
    </Link>
  );
}

/**
 * Вертикальна стрічка живих вакансій у лимонній панелі головної (напрям «Payday»): рядки
 * повільно їдуть донизу, як нові платежі. Доріжка = два однакові списки, зсув на -50% дає
 * безшовне коло. Пауза під курсором і фокусом; з клавіатури і під prefers-reduced-motion
 * стрічка стоїть і гортається. Коротка стрічка (менше FEED_MIN_TO_ROLL) просто стоїть.
 */
export function JobFeed({ jobs }: { jobs: readonly TickerJob[] }) {
  if (jobs.length === 0) return null;
  const moving = jobs.length >= FEED_MIN_TO_ROLL;
  const list = (copy: boolean) => (
    <ul aria-hidden={copy || undefined}>
      {jobs.map((job) => (
        <li key={job.ref}>
          <Row job={job} copy={copy} />
        </li>
      ))}
    </ul>
  );
  return (
    <div
      className="ncj-feed"
      data-moving={moving}
      style={{ "--feed-dur": `${jobs.length * SECONDS_PER_ROW}s` } as CSSProperties}
    >
      <div className="ncj-feed-track">
        {list(false)}
        {moving ? list(true) : null}
      </div>
    </div>
  );
}
