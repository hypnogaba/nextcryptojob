import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminNav } from "@/components/admin-nav";
import { BOARD, TABLE, TD_TIGHT, TH_TIGHT, TR } from "@/components/board";
import {
  ago,
  ATS_WINDOW_DAYS,
  CACHE_TTL_MS,
  cachedJobSourcesReport,
  LIVE_WINDOW_DAYS,
  loadJobSourcesReport,
  POSTED_WINDOW_DAYS,
  SCAN_TIME_UTC,
  STALE_AFTER_SCANS,
  type JobSource,
  type JobSourcesReport,
} from "@/lib/admin/job-sources";
import { failingAdvice, loadBoardsReport, SMALL_SOURCE_JOBS, type Board, type BoardsReport } from "@/lib/admin/boards";
import { currentAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { jobsDb } from "@/lib/jobs-db";
import { externalRel } from "@/lib/jobs/link";

export const metadata: Metadata = { title: "Job sources", robots: { index: false } };

/**
 * Адмінка: усі джерела вакансій, з яких складається добірка. Дані й кеш у
 * lib/admin/job-sources.ts; тут лише показ.
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
        <a href={source.url} target="_blank" rel={externalRel(source.url)} className="font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand">
          {source.name}
        </a>
      ) : (
        <span className="font-semibold text-ink">{source.name}</span>
      )}
      <div className="font-mono text-xs text-ink-muted">{source.key}</div>
    </>
  );
}

const TD = TD_TIGHT;
const TD_NUM = `${TD} text-right tabular-nums`;

function SourceRow({ s, now }: { s: JobSource; now: number }) {
  return (
    <tr className={TR} data-stale={s.stale ? "" : undefined}>
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
  );
}

function SourcesHead() {
  return (
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
  );
}

function Report({ report, now }: { report: JobSourcesReport; now: number }) {
  const { sources, company, totals } = report;
  const scan = totals.lastScan;
  // Малі джерела (менше SMALL_SOURCE_JOBS живих) згорнуто: їх сотні, а читати треба великі.
  const big = sources.filter((s) => s.liveJobs >= SMALL_SOURCE_JOBS);
  const small = sources.filter((s) => s.liveJobs < SMALL_SOURCE_JOBS);
  const smallJobs = small.reduce((n, s) => n + s.liveJobs, 0);
  return (
    <>
      {totals.scannerStale ? (
        <p role="alert" className="mt-6 rounded-lg border border-destructive/50 bg-surface px-4 py-3 text-sm text-ink">
          The job scanner missed its last scheduled run (daily at {SCAN_TIME_UTC})
          {scan ? `; last run ${ago(scan.at, now)}` : ""}. Sources look stale because of that, not because they
          broke.
        </p>
      ) : null}

      <dl className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          value={NUM.format(totals.liveJobs)}
          label="Live web3 jobs"
          note={`${NUM.format(totals.crawlLiveJobs)} scanned, ${NUM.format(totals.companyLiveJobs)} companies`}
        />
        <Tile value={NUM.format(totals.activeSources)} label="Active sources" note={`In the last ${STALE_AFTER_SCANS} scans`} />
        <Tile
          value={NUM.format(totals.staleSources)}
          label="Stale sources"
          note={`Missed the last ${STALE_AFTER_SCANS} scans`}
          alert={totals.staleSources > 0}
        />
        <Tile
          value={scan ? `${SCAN_TIME.format(scan.at)} UTC` : "Unknown"}
          label="Newest scan"
          note={scan ? `${ago(scan.at, now)}${scan.status ? `, ${scan.status}` : ""}` : "No scan recorded"}
          alert={totals.scannerStale}
        />
      </dl>

      <h2 className="display mt-10 text-[1.75rem] leading-none">Sources with {SMALL_SOURCE_JOBS}+ live jobs</h2>
      <div className={`mt-4 ${BOARD}`}>
        <table className={`${TABLE} min-w-[760px]`} data-table="big-sources">
          <SourcesHead />
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
            {big.map((s) => (
              <SourceRow key={s.key} s={s} now={now} />
            ))}
          </tbody>
        </table>
      </div>

      {small.length > 0 ? (
        <details className="group mt-4" data-small-sources={small.length}>
          <summary className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-4 text-sm font-semibold text-ink hover:border-line-strong">
            <span className="group-open:hidden">Show {NUM.format(small.length)} small sources</span>
            <span className="hidden group-open:inline">Hide {NUM.format(small.length)} small sources</span>
            <span className="font-normal text-ink-muted">
              fewer than {SMALL_SOURCE_JOBS} live jobs each, {NUM.format(smallJobs)} live jobs together,{" "}
              {NUM.format(small.filter((x) => x.stale).length)} stale
            </span>
          </summary>
          <div className={`mt-3 ${BOARD}`}>
            <table className={`${TABLE} min-w-[760px]`} data-table="small-sources">
              <SourcesHead />
              <tbody>
                {small.map((s) => (
                  <SourceRow key={s.key} s={s} now={now} />
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}

      <div className="mt-6 grid max-w-prose gap-2 text-xs text-ink-muted">
        <p>
          Live: tagged web3, listed by the latest scan of its source (if the source fails, for {LIVE_WINDOW_DAYS} days
          after its last good scan), posted in the last {ATS_WINDOW_DAYS} days on an employer&apos;s own ATS or{" "}
          {POSTED_WINDOW_DAYS} days on a job board or aggregator (no posting date: first seen by the scan), company not
          on the non-crypto list. Role matching per person comes later, and the
          same job on two sources counts twice here. With salary: live jobs that state a salary. Total web3: every
          web3 job from the source still in the cache. For company jobs, Live means in the digest now and Total means
          open.
        </p>
        <p>
          {NUM.format(sources.length)} of {NUM.format(totals.allSources)} sources in the jobs database have web3 jobs;
          the rest are left out. Stale: no job from the source in the last {STALE_AFTER_SCANS} scans. The scanner
          runs every day, weekends included, at {SCAN_TIME_UTC}.
        </p>
      </div>
    </>
  );
}

const DECISION: Record<Board["decision"], { label: string; cls: string }> = {
  discover: { label: "Discover", cls: "border-brand text-ink" },
  manual: { label: "Manual", cls: "border-line-strong text-ink" },
  skip: { label: "Skip", cls: "border-line text-ink-muted" },
};

const PLATFORM: Record<string, string> = {
  getro: "Getro",
  consider: "Consider",
  pallet: "Pallet",
  custom: "Own site",
  ats: "ATS",
  none: "None",
};

function Problems({ report, now }: { report: BoardsReport; now: number }) {
  const list = report.failing;
  const serious = list.filter((f) => f.status === "dead" || f.failDays >= 2);
  return (
    <section id="problems" aria-labelledby="problems-title" className="mt-12 scroll-mt-6">
      <h2 id="problems-title" className="display text-[1.75rem] leading-none">
        Problems
      </h2>
      <p className="mt-2 max-w-prose text-sm text-ink-muted">
        Sources whose last scans failed. You get a Telegram alert when a source fails 2 scans in a row or dies; the same
        source at most once a week. After 7 failing days a source is dead and is only tried once a week.
      </p>
      {list.length === 0 ? (
        <p role="status" className="mt-4 rounded-lg border border-line bg-surface px-4 py-3 text-sm text-ink">
          Every source answered its last scan.
        </p>
      ) : (
        <>
          <p className="mt-3 text-sm text-ink">
            <b className={serious.length ? "text-danger" : "text-ink"}>{NUM.format(serious.length)}</b> need a look (2+ failed
            scans or dead), {NUM.format(list.length - serious.length)} failed once.
          </p>
          <div className={`mt-4 ${BOARD}`}>
            <table className={`${TABLE} min-w-[760px]`} data-table="problems">
              <thead>
                <tr>
                  <th scope="col" className={TH_TIGHT}>Source</th>
                  <th scope="col" className={TH_TIGHT}>State</th>
                  <th scope="col" className={TH_TIGHT}>Last error</th>
                  <th scope="col" className={TH_TIGHT}>What to do</th>
                </tr>
              </thead>
              <tbody>
                {list.map((f) => (
                  <tr key={f.source} className={TR} data-failing={f.status}>
                    <td className={`${TD} font-mono text-xs break-all`}>{f.source}</td>
                    <td className={`${TD} whitespace-nowrap`}>
                      <span className={f.status === "dead" || f.failDays >= 2 ? "text-xs font-semibold text-danger" : "text-xs text-ink-muted"}>
                        {f.status === "dead" ? "Dead" : `Failing ${f.failDays} ${f.failDays === 1 ? "scan" : "scans"}`}
                      </span>
                      <div className="text-xs text-ink-muted">
                        since <Seen at={f.failedAt} now={now} />
                      </div>
                    </td>
                    <td className={`${TD} max-w-64 text-xs break-words text-ink-muted`}>{f.lastError ?? ""}</td>
                    <td className={`${TD} max-w-80 text-xs text-ink`}>{failingAdvice(f)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function BoardRow({ b }: { b: Board }) {
  return (
    <tr className={TR} data-board={b.slug} data-decision={b.decision}>
      <td className={TD}>
        {b.url ? (
          <a href={b.url} target="_blank" rel={externalRel(b.url)} className="font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand">
            {b.label}
          </a>
        ) : (
          <span className="font-semibold text-ink">{b.label}</span>
        )}
        <div className="text-xs text-ink-muted capitalize">{b.kind}</div>
      </td>
      <td className={`${TD} text-ink-muted`}>{PLATFORM[b.platform] ?? b.platform}</td>
      <td className={TD}>
        <span className={`inline-block rounded border px-1.5 py-0.5 text-xs font-semibold ${DECISION[b.decision].cls}`}>
          {DECISION[b.decision].label}
        </span>
        {b.decision === "skip" && b.reason ? <div className="mt-1 max-w-56 text-xs text-ink-muted">{b.reason}</div> : null}
      </td>
      <td className={TD_NUM}>
        {b.lastRun ? NUM.format(b.lastRun.companies) : b.listed !== null ? NUM.format(b.listed) : ""}
        {b.lastRun ? (
          <div className="text-xs text-ink-muted">{NUM.format(b.lastRun.withJobs)} hiring</div>
        ) : b.listed !== null ? (
          <div className="text-xs text-ink-muted">checked {b.checkedAt}</div>
        ) : null}
      </td>
      <td className={`${TD} text-xs`}>
        {b.lastRun?.error ? (
          <span className="font-semibold text-danger">No answer: {b.lastRun.error}</span>
        ) : b.lastRun ? (
          <span className="text-ink-muted">
            {NUM.format(b.lastRun.known)} already known, {NUM.format(b.lastRun.added)} new
            {b.lastRun.hostedOnly ? `, ${NUM.format(b.lastRun.hostedOnly)} hire only on the board` : ""}
          </span>
        ) : (
          <span className="text-ink-muted">{b.decision === "discover" ? "Not read yet" : ""}</span>
        )}
      </td>
      <td className={TD_NUM}>
        {NUM.format(b.added)}
        {b.added > b.enabled ? <div className="text-xs text-ink-muted">{NUM.format(b.enabled)} enabled</div> : null}
      </td>
    </tr>
  );
}

function BoardsHead() {
  return (
    <thead>
      <tr>
        <th scope="col" className={TH_TIGHT}>Board</th>
        <th scope="col" className={TH_TIGHT}>Platform</th>
        <th scope="col" className={TH_TIGHT}>Decision</th>
        <th scope="col" className={`${TH_TIGHT} text-right`}>Companies found</th>
        <th scope="col" className={TH_TIGHT}>Last discovery</th>
        <th scope="col" className={`${TH_TIGHT} text-right`}>Employers added</th>
      </tr>
    </thead>
  );
}

function Boards({ report, now }: { report: BoardsReport; now: number }) {
  const d = report.discovery;
  const discover = report.boards.filter((b) => b.decision === "discover");
  const added = report.boards.reduce((n, b) => n + b.added, 0);
  // Пропущені дошки (Skip) згорнуто: їх багато, а причина довга; читаємо ті, що дають роботодавців.
  const read = report.boards.filter((b) => b.decision !== "skip");
  const skipped = report.boards.filter((b) => b.decision === "skip");
  return (
    <section id="boards" aria-labelledby="boards-title" className="mt-12 scroll-mt-6">
      <h2 id="boards-title" className="display text-[1.75rem] leading-none">
        Ecosystem and fund boards
      </h2>
      <div className="mt-3 grid max-w-prose gap-2 text-sm text-ink">
        <p>
          <b>How it works.</b> We do not copy jobs from these boards. Once a week (Sunday 05:30 UTC) discovery reads the
          company list of every board marked Discover. For each company we do not know yet it finds the link to the
          company&apos;s own job system (Greenhouse, Lever, Ashby and others) and adds the company to our employer
          registry. From then on the daily scan ({SCAN_TIME_UTC}) reads that company&apos;s jobs straight from its own job
          system, so they show up above as ATS sources.
        </p>
        <p className="text-ink-muted">
          Manual: the board&apos;s platform does not allow reading it, so its portfolio companies were added by hand.
          Skip: not read, the reason is in the row.
        </p>
        <p className="text-ink-muted">
          <b className="text-ink">What you do with this.</b> Nothing, while the numbers above look sane. The list is
          the log of last Sunday&apos;s run, kept for one case: a board that stops giving employers. You hear about that
          in an alert; then open its link, and if it moved or changed platform, fix it in db/jobs/seed/boards.json.
        </p>
      </div>
      <dl className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile value={NUM.format(report.boards.length)} label="Boards" note={`${NUM.format(discover.length)} read by discovery`} />
        <Tile value={NUM.format(added)} label="Employers added" note="From boards, all time" />
        <Tile
          value={d ? ago(d.at, now) : "Never"}
          label="Last discovery"
          note={d ? `${d.status}, ${NUM.format(d.added)} new employers` : "No run recorded"}
          alert={d?.status === "failed"}
        />
        <Tile
          value={d?.getroEnabled ? "On" : d ? "Off" : "Unknown"}
          label="Board reading"
          note={d?.getroEnabled ? "Company lists read weekly" : "JOBS_GETRO_DISCOVERY on the VPS"}
          alert={d !== null && !d.getroEnabled}
        />
      </dl>
      <details className="group mt-5" data-boards={read.length}>
        <summary className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-4 text-sm font-semibold text-ink hover:border-line-strong">
          <span className="group-open:hidden">Show the board list ({NUM.format(read.length)})</span>
          <span className="hidden group-open:inline">Hide the board list</span>
          <span className="font-normal text-ink-muted">Nothing to do here while discovery runs: it is a log, not a task list</span>
        </summary>
        <div className={`mt-3 ${BOARD}`}>
          <table className={`${TABLE} min-w-[820px]`} data-table="boards">
            <BoardsHead />
            <tbody>
              {read.map((b) => (
                <BoardRow key={b.slug} b={b} />
              ))}
            </tbody>
          </table>
        </div>
      </details>
      {skipped.length > 0 ? (
        <details className="group mt-4" data-skipped-boards={skipped.length}>
          <summary className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-4 text-sm font-semibold text-ink hover:border-line-strong">
            <span className="group-open:hidden">Show {NUM.format(skipped.length)} skipped boards</span>
            <span className="hidden group-open:inline">Hide {NUM.format(skipped.length)} skipped boards</span>
            <span className="font-normal text-ink-muted">not read, each with its reason</span>
          </summary>
          <div className={`mt-3 ${BOARD}`}>
            <table className={`${TABLE} min-w-[820px]`} data-table="skipped-boards">
              <BoardsHead />
              <tbody>
                {skipped.map((b) => (
                  <BoardRow key={b.slug} b={b} />
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </section>
  );
}

export default async function AdminSourcesPage() {
  if (!(await currentAdmin())) notFound();

  let report: JobSourcesReport | null = null;
  let failure: string | null = null;
  let boards: BoardsReport | null = null;
  let boardsFailure: string | null = null;
  try {
    report = await cachedJobSourcesReport((now) => loadJobSourcesReport(jobsDb(), db(), now));
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }
  try {
    boards = await loadBoardsReport(jobsDb());
  } catch (e) {
    boardsFailure = e instanceof Error ? e.message : String(e);
  }
  // Серверний компонент рендериться раз на запит: «зараз» тут і є час запиту.
  const now = new Date().getTime();

  return (
    <section className="mx-auto px-[clamp(16px,4vw,56px)] pt-8 pb-20 sm:pt-12 max-w-5xl">
      <AdminNav current="/admin/sources" />
      <h1 className="display text-title">Job sources</h1>
      <p className="mt-2 max-w-prose text-sm text-ink-muted">
        Where daily jobs come from: our crypto job scanner (its own jobs database, read only here) and jobs companies post here.
        {report
          ? ` Updated ${ago(report.computedAt, now)}, recounted every ${CACHE_TTL_MS / 60_000} min.`
          : ""}
      </p>
      <p className="mt-3 flex flex-wrap gap-x-4 text-sm">
        <a href="#problems" className="inline-flex min-h-11 items-center font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand">
          Problems{boards && boards.failing.length ? ` (${NUM.format(boards.failing.length)})` : ""}
        </a>
        <a href="#boards" className="inline-flex min-h-11 items-center font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand">
          Ecosystem and fund boards{boards ? ` (${NUM.format(boards.boards.length)})` : ""}
        </a>
      </p>
      {failure !== null ? (
        <p role="alert" className="mt-6 rounded-lg border border-destructive/50 bg-surface px-4 py-3 text-sm text-ink">
          Could not read the job sources: {failure}
        </p>
      ) : null}
      {report ? <Report report={report} now={now} /> : null}
      {boardsFailure !== null ? (
        <p role="alert" className="mt-10 rounded-lg border border-destructive/50 bg-surface px-4 py-3 text-sm text-ink">
          Could not read boards and source problems: {boardsFailure}
        </p>
      ) : null}
      {boards ? (
        <>
          <Problems report={boards} now={now} />
          <Boards report={boards} now={now} />
        </>
      ) : null}
    </section>
  );
}
