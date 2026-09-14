import { ArrowUpRight, Check } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { logoPath } from "@/lib/jobs/companies";
import { applyLink, externalJobLink } from "@/lib/jobs/link";
import { CompanyLogo } from "./company-logo";

/**
 * Картка вакансії на /jobs: значок і назва компанії, місце й зарплата, «чому підходить», про компанію,
 * і "Apply" одразу. Одна картка і для «зараз», і для надісланого раніше.
 *
 * Посилання не збирає сама: rel і адресу вирішує lib/jobs/link.ts (web3.career: apply_url як є, follow,
 * з реферером, і web3.career названо джерелом).
 */

export type CardJob = {
  title: string;
  company: string;
  location: string | null;
  /** Вилка роботодавця («$120k to $150k»). */
  salary: string | null;
  /** Оцінка дошки («est. … (web3.career estimate)»), лише без вилки: приглушено, не зарплата. */
  salaryEstimate?: string | null;
  /** Адреса вакансії: http(s), mailto або сторінка вакансії компанії на сайті `/jobs/<id>`; null, якщо крива. */
  url: string | null;
  /** «Posted by {Company} on NextCryptoJob» для вакансій компаній. */
  postedBy: string | null;
  about?: string | null;
  domain?: string | null;
};

// Текст із чужих дощок буває одним довгим словом: переносимо будь-де, щоб 390 px не роз'їхались.
const WRAP = "min-w-0 wrap-anywhere";
const TITLE_LINK = "underline decoration-transparent underline-offset-4 transition-colors hover:decoration-brand focus-visible:decoration-brand";

function Title({ job }: { job: CardJob }) {
  const url = job.url;
  if (!url) return <>{job.title}</>;
  // Вакансія компанії: її сторінка на сайті, у тій самій вкладці.
  if (url.startsWith("/")) {
    return (
      <Link href={url} prefetch={false} className={TITLE_LINK}>
        {job.title}
      </Link>
    );
  }
  const link = externalJobLink(url);
  if (!link) return <>{job.title}</>;
  if (link.href.startsWith("mailto:")) {
    return (
      <a href={link.href} className={TITLE_LINK}>
        {job.title}
      </a>
    );
  }
  return (
    <a href={link.href} target="_blank" rel={link.rel} className={TITLE_LINK}>
      {job.title}
    </a>
  );
}

function Facts({ job }: { job: CardJob }) {
  const chip = "inline-flex min-h-7 items-center rounded-md px-2.5 text-[0.8125rem] leading-tight";
  if (!job.location && !job.salary && !job.salaryEstimate) return null;
  return (
    <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Where and pay">
      {job.location ? <li className={`${chip} border border-line bg-surface text-ink ${WRAP}`}>{job.location}</li> : null}
      {job.salary ? (
        <li className={`${chip} bg-ink font-semibold text-ground tabular-nums`}>{job.salary}</li>
      ) : job.salaryEstimate ? (
        // Оцінка дошки, не зарплата: приглушено й окремо від зарплати.
        <li className={`${chip} border border-dashed border-line-strong text-ink-muted ${WRAP}`}>{job.salaryEstimate}</li>
      ) : (
        <li className={`${chip} text-ink-muted`}>Salary not listed</li>
      )}
    </ul>
  );
}

function Why({ reasons, why, note, label }: { reasons?: readonly string[]; why?: string | null; note?: string | null; label: string }) {
  const list = reasons?.length ? reasons : null;
  if (!list && !why) return null;
  return (
    <div className="mt-4 rounded-lg bg-brand-soft px-4 py-3.5">
      <p className="text-xs font-bold tracking-[0.08em] text-brand uppercase">{label}</p>
      {list ? (
        <ul className="mt-2 grid gap-1.5">
          {list.map((r) => (
            <li key={r} className={`flex gap-2 text-[0.9375rem] leading-snug text-ink ${WRAP}`}>
              <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-brand" strokeWidth={3} />
              <span>{r}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={`mt-1.5 text-[0.9375rem] leading-snug text-ink ${WRAP}`}>{why}</p>
      )}
      {note ? <p className={`mt-2 text-sm text-ink-muted ${WRAP}`}>{note}</p> : null}
    </div>
  );
}

function Apply({ job, compact }: { job: CardJob; compact: boolean }) {
  const apply = applyLink(job.url);
  const note = job.postedBy ? `Posted by ${job.postedBy} on NextCryptoJob` : apply?.via ? `via ${apply.via}` : null;
  if (!apply) {
    return note ? <p className={`mt-4 text-xs text-ink-muted ${WRAP}`}>{note}</p> : null;
  }
  return (
    <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2">
      <Button asChild size={compact ? "default" : "lg"} variant={compact ? "outline" : "default"} className="w-full sm:w-auto">
        <a href={apply.href} {...(apply.newTab ? { target: "_blank", rel: apply.rel ?? undefined } : {})}>
          {apply.label}
          {apply.newTab ? <ArrowUpRight aria-hidden="true" data-icon="inline-end" /> : null}
          {apply.newTab ? <span className="sr-only"> (opens in a new tab)</span> : null}
        </a>
      </Button>
      {note ? <p className={`text-xs text-ink-muted ${WRAP}`}>{note}</p> : null}
    </div>
  );
}

export function JobCard({
  job,
  reasons,
  why,
  note,
  rank,
  compact = false,
}: {
  job: CardJob;
  /** Причини списком (вибір «зараз»). */
  reasons?: readonly string[];
  /** Причини одним рядком (sent.why надісланого раніше). */
  why?: string | null;
  /** «Still open, posted 6 weeks ago.» поруч із причинами. */
  note?: string | null;
  /** Місце у виборі: 1..5. */
  rank?: number;
  /** Надіслане раніше: тихіша кнопка. */
  compact?: boolean;
}) {
  const domain = job.domain ?? null;
  return (
    <li className="rounded-xl border border-line bg-surface p-4 shadow-rest sm:p-6">
      <div className="flex items-start gap-3.5 sm:gap-4">
        <CompanyLogo name={job.company} src={logoPath(domain)} size={compact ? 40 : 48} />
        <div className="min-w-0 flex-1">
          <h3 className={`font-sans text-[1.0625rem] leading-snug font-semibold text-ink sm:text-lg ${WRAP}`}>
            <Title job={job} />
          </h3>
          <p className={`mt-0.5 text-sm text-ink-muted ${WRAP}`}>
            <span className="font-medium text-ink">{job.company}</span>
            {domain ? <span> · {domain}</span> : null}
          </p>
        </div>
        {rank ? (
          <span className="font-display text-2xl leading-none font-extrabold text-line-strong tabular-nums" aria-label={`Match ${rank}`}>
            {String(rank).padStart(2, "0")}
          </span>
        ) : null}
      </div>
      <Facts job={job} />
      <Why reasons={reasons} why={why} note={note} label={compact ? "Why we sent it" : "Why this fits you"} />
      {job.about ? (
        <p className={`mt-4 text-sm leading-relaxed text-ink-muted ${WRAP}`}>
          <span className="font-semibold text-ink">About {job.company}.</span> {job.about}
        </p>
      ) : null}
      <Apply job={job} compact={compact} />
    </li>
  );
}
