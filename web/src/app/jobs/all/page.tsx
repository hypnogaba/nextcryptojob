import type { Metadata } from "next";
import Link from "next/link";
import { AccountShell } from "@/components/account-nav";
import { FIELD, HINT } from "@/components/form/styles";
import { JobCard } from "@/components/jobs/job-card";
import { Button } from "@/components/ui/button";
import { currentUser } from "@/lib/auth/session";
import { ROLES, type RoleKey } from "@/lib/card/roles";
import { appEnv, db } from "@/lib/db";
import { jobsDb } from "@/lib/jobs-db";
import { browseHref, browseInputOf, browseJobs, type BrowseInput, type BrowseResult } from "@/lib/jobs/browse";
import { listSavedRefs } from "@/lib/jobs/saved";

export const metadata: Metadata = { title: "All jobs", robots: { index: false } };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const NUM = new Intl.NumberFormat("en-US");
const TEXT_LINK = "font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink";

function Filters({ input }: { input: BrowseInput }) {
  return (
    <form action="/jobs/all" method="get" role="search" className="grid gap-3 rounded-3xl bg-soft p-5 sm:grid-cols-[minmax(0,1fr)_220px_auto_auto] sm:items-end sm:p-6">
      <label className="grid gap-1 text-sm">
        <span className="font-semibold text-ink">Title, company or skill</span>
        <input type="search" name="q" defaultValue={input.q} placeholder="Solidity, Coinbase, growth" className={FIELD} />
      </label>
      <label className="grid gap-1 text-sm">
        <span className="font-semibold text-ink">Role</span>
        <select name="role" defaultValue={input.role ?? ""} className={FIELD}>
          <option value="">Any role</option>
          {(Object.keys(ROLES) as RoleKey[]).map((r) => (
            <option key={r} value={r}>
              {ROLES[r].name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm font-semibold text-ink">
        <input type="checkbox" name="remote" value="1" defaultChecked={input.remote} className="size-5 accent-[var(--color-ink)]" />
        Remote only
      </label>
      {input.company ? <input type="hidden" name="company" value={input.company} /> : null}
      <Button type="submit" size="lg">
        Search
      </Button>
    </form>
  );
}

function Pager({ input, result }: { input: BrowseInput; result: Extract<BrowseResult, { state: "ok" }> }) {
  if (result.pages <= 1) return null;
  return (
    <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-3">
      {result.page > 1 ? (
        <Link href={browseHref(input, { page: result.page - 1 })} className={TEXT_LINK}>
          Newer jobs
        </Link>
      ) : (
        <span />
      )}
      <span className={HINT}>
        Page {result.page} of {result.pages}
      </span>
      {result.page < result.pages ? (
        <Link href={browseHref(input, { page: result.page + 1 })} className={TEXT_LINK}>
          Older jobs
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}

function Results({ input, result, savedRefs }: { input: BrowseInput; result: BrowseResult; savedRefs: ReadonlySet<string> | null }) {
  if (result.state === "unavailable") {
    return (
      <div role="status" className="grid gap-1 rounded-3xl bg-soft p-5 sm:p-6">
        <p className="font-medium text-ink">We could not load live jobs right now.</p>
        <p className={HINT}>Nothing is lost. Try again in a minute.</p>
      </div>
    );
  }
  const filtered = Boolean(input.q || input.role || input.remote || input.company);
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-base text-ink sm:text-lg" aria-live="polite">
          <strong className="font-semibold">{NUM.format(result.total)}</strong> live {result.total === 1 ? "job" : "jobs"}
          {result.companyName ? ` at ${result.companyName}` : filtered ? " match" : ""}, newest first.
        </p>
        {filtered ? (
          <Link href="/jobs/all" className={TEXT_LINK}>
            Clear filters
          </Link>
        ) : null}
      </div>
      {result.jobs.length === 0 ? (
        <p className={HINT}>No live job matches that. Try fewer words or another role.</p>
      ) : (
        <ol className="grid gap-4">
          {result.jobs.map((j) => (
            <JobCard
              key={j.ref}
              job={j}
              compact
              jobRef={savedRefs ? j.ref : undefined}
              saved={savedRefs?.has(j.ref)}
              openRoles={
                j.openRoles > 1 && j.companyKey !== input.company
                  ? { count: j.openRoles, href: browseHref({ q: "", role: null, remote: false, company: j.companyKey, page: 1 }) }
                  : null
              }
            />
          ))}
        </ol>
      )}
      <Pager input={input} result={result} />
    </div>
  );
}

/**
 * /jobs/all (власник 16.09, j5): усі живі вакансії з пошуком, а не лише п'ять надісланих. Відкрита
 * й без входу (ті самі дані, що публічний search_jobs); увійшла людина бачить її у своєму кабінеті
 * з кнопкою Save.
 */
export default async function AllJobsPage({ searchParams }: Props) {
  const input = browseInputOf(await searchParams);
  const user = await currentUser();
  const d = db();
  const [result, savedRefs] = await Promise.all([
    browseJobs({ db: d, env: appEnv(), jobs: jobsDb, now: new Date() }, input),
    user ? listSavedRefs(d, user.id) : Promise.resolve(null),
  ]);
  const body = (
    <div className="grid max-w-[900px] gap-6">
      <Filters input={input} />
      <Results input={input} result={result} savedRefs={savedRefs} />
    </div>
  );
  if (user) {
    return (
      <AccountShell active="jobs" title="All jobs" sub="Every live crypto job we track, with the company behind it.">
        <p className="mb-6">
          <Link href="/jobs" className={TEXT_LINK}>
            Back to your matches
          </Link>
        </p>
        {body}
      </AccountShell>
    );
  }
  return (
    <section className="mx-auto max-w-[1360px] px-[clamp(16px,4vw,56px)] pt-8 pb-20 sm:pt-14">
      <h1 className="display text-title">All jobs</h1>
      <p className="mt-2 text-ink-muted">
        Every live crypto job we track.{" "}
        <Link href="/start" className={TEXT_LINK}>
          Create a profile
        </Link>{" "}
        to get the best five for you every day.
      </p>
      <div className="mt-8">{body}</div>
    </section>
  );
}
