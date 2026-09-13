import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminNav } from "@/components/admin-nav";
import { BOARD, TABLE, TD_TIGHT, TH_TIGHT, TR } from "@/components/board";
import {
  ago,
  CACHE_TTL_MS,
  cachedJobSourcesReport,
  LIVE_WINDOW_DAYS,
  loadJobSourcesReport,
  POSTED_WINDOW_DAYS,
  STALE_AFTER_HOURS,
  type JobSource,
  type JobSourcesReport,
} from "@/lib/admin/job-sources";
import { currentAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { jobsDb } from "@/lib/jobs-db";

export const metadata: Metadata = { title: "Job sources", robots: { index: false } };

/**
 * Адмінка: усі джерела вакансій, з яких складається добірка (як блок «Джерела»
 * в адмінці NextRole). Дані й кеш у lib/admin/job-sources.ts; тут лише показ.
 */

const NUM = new Intl.NumberFormat("en-US");
const SCAN_TIME = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC",
});
const EXACT = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

function Seen({ at, now }: { at: number | null; now: number }) {
  if (at === null) return <span className="text-ink-muted">never</span>;
  return <time dateTime={new Date(at).toISOString()} title={`${EXACT.format(at)} UTC`}>{ago(at, now)}</time>;
}

function Tile({ value, label, note, alert = false }: { value: string; label: string; note?: string; alert?: boolean }) {
  return (
    <div className={`rounded-xl border bg-surface px-4 py-3 ${alert ? "border-destructive/50" : "border-line"}`}>
      <dt className="text-sm font-semibold text-ink-muted">{label}</dt>
      <dd className={`mt-1 font-display text-[1.75rem] leading-none font-black tabular-nums sm:text-[2rem] ${alert ? "text-danger" : "text-ink"}`}>{value}</dd>
      {note ? <dd className="mt-1 text-xs text-ink-muted">{note}</dd> : null}
    </div>
  );
}

function SourceName({ source }: { source: JobSource }) {
  return (
    <>
      {source.url ? (
        <a href={source.url} target="_blank" rel="noreferrer noopener" className="font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand">
          {source.name}
        </a>
      ) : (
        <span className="font-semibold text-ink">{source.name}</span>
      )}
      <div className="font-mono text-xs text-ink-muted">
        {source.key}
        {source.country ? ` (${source.country} only)` : ""}
      </div>
    </>
  );
}

const TD = TD_TIGHT;
const TD_NUM = `${TD} text-right tabular-nums`;

function Report({ report, now }: { report: JobSourcesReport; now: number }) {
  const { sources, company, totals } = report;
  const scan = totals.lastScan;
  return (
    <>
      {totals.scannerStale ? (
        <p role="alert" className="mt-6 rounded-lg border border-destructive/50 bg-surface px-4 py-3 text-sm text-ink">
          The NextRole scanner has not run for over {STALE_AFTER_HOURS} h
          {scan ? ` (last run ${ago(scan.at, now)})` : ""}. Every source looks stale because of that, not
          because the sources broke.
        </p>
      ) : null}

      <dl className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          value={NUM.format(totals.liveJobs)}
          label="Live web3 jobs"
          note={`${NUM.format(totals.nextroleLiveJobs)} NextRole, ${NUM.format(totals.companyLiveJobs)} companies`}
        />
        <Tile value={NUM.format(totals.activeSources)} label={`Active in ${STALE_AFTER_HOURS} h`} note="NextRole sources" />
        <Tile
          value={NUM.format(totals.staleSources)}
          label="Stale sources"
          note={`Nothing seen for ${STALE_AFTER_HOURS} h`}
          alert={totals.staleSources > 0}
        />
        <Tile
          value={scan ? `${SCAN_TIME.format(scan.at)} UTC` : "Unknown"}
          label="Newest scan"
          note={scan ? `${ago(scan.at, now)}${scan.status ? `, ${scan.status}` : ""}` : "No scan recorded"}
          alert={totals.scannerStale}
        />
      </dl>

      <div className={`mt-8 ${BOARD}`}>
        <table className={`${TABLE} min-w-[760px]`}>
          <thead>
            <tr>
              <th scope="col" className={TH_TIGHT}>Source</th>
              <th scope="col" className={`${TH_TIGHT} text-right`}>Live</th>
              <th scope="col" className={`${TH_TIGHT} text-right`}>With salary</th>
              <th scope="col" className={`${TH_TIGHT} text-right`}>Total web3</th>
              <th scope="col" className={TH_TIGHT}>Newest</th>
              <th scope="col" className={TH_TIGHT}>Status</th>
              <th scope="col" className={TH_TIGHT}>Kind</th>
            </tr>
          </thead>
          <tbody>
            <tr className={`${TR} bg-wash`}>
              <td className={TD}>
                <Link href="/admin/companies" className="font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand">
                  Company jobs (NextCryptoJob)
                </Link>
                <div className="font-mono text-xs text-ink-muted">company_jobs</div>
              </td>
              <td className={TD_NUM}>{NUM.format(company.liveJobs)}</td>
              <td className={TD_NUM}>{NUM.format(company.liveWithSalary)}</td>
              <td className={TD_NUM} title="Open jobs">{NUM.format(company.openJobs)}</td>
              <td className={TD}><Seen at={company.newestAt} now={now} /></td>
              <td className={`${TD} text-xs text-ink-muted`}>Not scanned</td>
              <td className={`${TD} text-ink-muted`}>Posted here</td>
            </tr>
            {sources.map((s) => (
              <tr key={s.key} className={TR} data-stale={s.stale ? "" : undefined}>
                <td className={TD}><SourceName source={s} /></td>
                <td className={TD_NUM}>{NUM.format(s.liveJobs)}</td>
                <td className={TD_NUM}>{NUM.format(s.liveWithSalary)}</td>
                <td className={TD_NUM}>{NUM.format(s.web3Jobs)}</td>
                <td className={TD}><Seen at={s.newestAt} now={now} /></td>
                <td className={TD}>
                  {s.stale ? (
                    <span className="text-xs font-semibold text-danger">Stale</span>
                  ) : (
                    <span className="text-xs text-ink-muted">Active</span>
                  )}
                </td>
                <td className={`${TD} text-ink-muted`}>{s.via}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-6 grid max-w-prose gap-2 text-xs text-ink-muted">
        <p>
          Live: tagged web3, seen by the NextRole scan in the last {LIVE_WINDOW_DAYS} days, posted in the last{" "}
          {POSTED_WINDOW_DAYS} days, company not on the non-crypto list. Role matching per person comes later, and the
          same job on two sources counts twice here. With salary: live jobs that state a salary. Total web3: every
          web3 job from the source still in the cache. For company jobs, Live means in the digest now and Total means
          open.
        </p>
        <p>
          {NUM.format(sources.length)} of {NUM.format(totals.allNextroleSources)} NextRole sources have web3 jobs; the
          rest are left out. Stale: the scan has not seen any job from the source for {STALE_AFTER_HOURS} h.
        </p>
      </div>
    </>
  );
}

export default async function AdminSourcesPage() {
  if (!(await currentAdmin())) notFound();

  let report: JobSourcesReport | null = null;
  let failure: string | null = null;
  try {
    report = await cachedJobSourcesReport((now) => loadJobSourcesReport(jobsDb(), db(), now));
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }
  // Серверний компонент рендериться раз на запит: «зараз» тут і є час запиту.
  const now = new Date().getTime();

  return (
    <section className="mx-auto px-[clamp(16px,4vw,56px)] pt-8 pb-20 sm:pt-12 max-w-5xl">
      <AdminNav current="/admin/sources" />
      <h1 className="display text-title">Job sources</h1>
      <p className="mt-2 max-w-prose text-sm text-ink-muted">
        Where daily jobs come from: the NextRole job cache (read only) and jobs companies post here.
        {report
          ? ` Updated ${ago(report.computedAt, now)}, recounted every ${CACHE_TTL_MS / 60_000} min.`
          : ""}
      </p>
      {failure !== null ? (
        <p role="alert" className="mt-6 rounded-lg border border-destructive/50 bg-surface px-4 py-3 text-sm text-ink">
          Could not read the job sources: {failure}
        </p>
      ) : null}
      {report ? <Report report={report} now={now} /> : null}
    </section>
  );
}
