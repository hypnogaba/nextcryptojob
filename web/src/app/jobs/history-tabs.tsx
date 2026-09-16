"use client";

import { useMemo, useState } from "react";
import { HINT } from "@/components/form/styles";
import { JobCard } from "@/components/jobs/job-card";
import { dayLabel } from "@/lib/digest/format";
import type { SentDigest, SentJob } from "@/lib/digest/history";
import { cn } from "@/lib/utils";

const WRAP = "min-w-0 wrap-anywhere";

/**
 * «Sent to you» у трьох вкладках (раунд 5, п.16): Today, Earlier (усе за 30 днів, з пошуком по
 * назві) і Saved (Save на картці, збережене з обох вкладок незалежно від дати). Власник ще не
 * підтвердив цю форму, зроблено як запропоновано (фідбек власника, п.16).
 */

const TAB = "inline-flex min-h-10 items-center rounded-full px-4 text-sm font-semibold transition-colors";
const TAB_ON = "bg-ink text-white";
const TAB_OFF = "bg-soft text-ink-muted hover:text-ink";

function SentItem({ job, savedRefs }: { job: SentJob; savedRefs: ReadonlySet<string> }) {
  if (!job.details) {
    return (
      <li className="grid gap-1 rounded-3xl border-[1.5px] border-dashed border-line-strong p-5 sm:p-6">
        <p className="text-base font-medium text-ink-muted">
          {job.state === "unavailable" ? "Job details are not available right now." : "This job is no longer listed."}
        </p>
        {job.why ? <p className={`${HINT} ${WRAP}`}>{job.why}</p> : null}
      </li>
    );
  }
  return <JobCard job={job.details} why={job.why} compact jobRef={job.ref} saved={savedRefs.has(job.ref)} />;
}

function DigestSection({ digest, savedRefs }: { digest: SentDigest; savedRefs: ReadonlySet<string> }) {
  const n = digest.jobs.length;
  const by = digest.channel === "telegram" ? "in Telegram" : digest.channel === "email" ? "by email" : null;
  const id = `digest-${digest.digestId}`;
  return (
    <section aria-labelledby={id} className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-line pb-2">
        <h3 id={id} className="font-display text-[1.375rem] leading-tight font-semibold tracking-[-0.015em]">
          {dayLabel(digest.localDate)}
        </h3>
        <p className="text-sm text-ink-muted">
          {n} job{n === 1 ? "" : "s"}
          {by ? `, ${by}` : ""}
        </p>
      </div>
      <ol className="grid gap-3">
        {digest.jobs.map((job) => (
          <SentItem key={job.ref} job={job} savedRefs={savedRefs} />
        ))}
      </ol>
    </section>
  );
}

function matchesSearch(job: SentJob, q: string): boolean {
  if (!q) return true;
  const title = job.details?.title?.toLowerCase() ?? "";
  return title.includes(q);
}

/** Ті самі добірки, лише з вакансіями, що пройшли пошук; порожні дні зникають. */
function filterDigests(digests: readonly SentDigest[], q: string): SentDigest[] {
  if (!q) return [...digests];
  return digests.map((d) => ({ ...d, jobs: d.jobs.filter((j) => matchesSearch(j, q)) })).filter((d) => d.jobs.length > 0);
}

export function HistoryTabs({
  digests,
  savedRefs,
  todayLocalDate,
}: {
  digests: SentDigest[];
  /** job_ref збережених вакансій (раунд 5, п.16). */
  savedRefs: string[];
  /** YYYY-MM-DD у поясі людини: межа між Today і Earlier. */
  todayLocalDate: string;
}) {
  const saved = useMemo(() => new Set(savedRefs), [savedRefs]);
  const today = useMemo(() => digests.filter((d) => d.localDate === todayLocalDate), [digests, todayLocalDate]);
  const earlier = useMemo(() => digests.filter((d) => d.localDate !== todayLocalDate), [digests, todayLocalDate]);
  const savedDigests = useMemo(
    () => digests.map((d) => ({ ...d, jobs: d.jobs.filter((j) => saved.has(j.ref)) })).filter((d) => d.jobs.length > 0),
    [digests, saved],
  );
  // Today з нічого: одразу відкриваємо Earlier, щоб вкладка не здавалась порожньою даремно
  // («Nothing sent today yet.» лишається доступним, натиснувши Today).
  const [tab, setTab] = useState<"today" | "earlier" | "saved">(() => (today.length > 0 || earlier.length === 0 ? "today" : "earlier"));
  const [q, setQ] = useState("");

  const shown = tab === "today" ? today : tab === "earlier" ? earlier : savedDigests;
  const filtered = tab === "saved" ? shown : filterDigests(shown, q.trim().toLowerCase());

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Sent to you" className="flex flex-wrap gap-2">
          <button type="button" role="tab" aria-selected={tab === "today"} onClick={() => setTab("today")} className={cn(TAB, tab === "today" ? TAB_ON : TAB_OFF)}>
            Today
          </button>
          <button type="button" role="tab" aria-selected={tab === "earlier"} onClick={() => setTab("earlier")} className={cn(TAB, tab === "earlier" ? TAB_ON : TAB_OFF)}>
            Earlier
          </button>
          <button type="button" role="tab" aria-selected={tab === "saved"} onClick={() => setTab("saved")} className={cn(TAB, tab === "saved" ? TAB_ON : TAB_OFF)}>
            Saved{savedDigests.length > 0 ? ` (${saved.size})` : ""}
          </button>
        </div>
        {tab !== "saved" ? (
          <label className="min-w-0 flex-1 sm:max-w-[260px]">
            <span className="sr-only">Search by job title</span>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by title"
              className="h-10 w-full rounded-full border border-line-strong bg-surface px-4 text-sm text-ink placeholder:text-ink-muted focus-visible:border-brand focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-brand"
            />
          </label>
        ) : null}
      </div>

      {filtered.length === 0 ? (
        <p className={HINT}>
          {tab === "saved"
            ? "Nothing saved yet. Save a job from its card to find it here later."
            : q
              ? "No saved job title matches that search."
              : tab === "today"
                ? "Nothing sent today yet."
                : "Nothing here yet."}
        </p>
      ) : (
        <div className="grid gap-8">
          {filtered.map((digest) => (
            <DigestSection key={digest.digestId} digest={digest} savedRefs={saved} />
          ))}
        </div>
      )}
    </div>
  );
}
