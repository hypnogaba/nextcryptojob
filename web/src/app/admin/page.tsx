import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminNav } from "@/components/admin-nav";
import { Ago, CLOCK, LINK, NUM, Panel, pct, Stat, Stats, SubHead } from "@/components/admin-ui";
import { BOARD, TABLE, TD_TIGHT, TH_TIGHT, TR } from "@/components/board";
import {
  cachedJobSourcesReport,
  LIVE_WINDOW_DAYS,
  loadJobSourcesReport,
  SCAN_TIME_UTC,
  STALE_AFTER_SCANS,
  type JobSourcesReport,
} from "@/lib/admin/job-sources";
import { loadOverview, overviewFlags, type Flag, type Overview } from "@/lib/admin/overview";
import { getSettings, type AppSettings } from "@/lib/admin/settings";
import { currentAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { jobsDb } from "@/lib/jobs-db";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Admin overview", robots: { index: false } };

/**
 * Головна адмінки: усе видно одним поглядом. Числа з D1 одним пакетом
 * (lib/admin/overview.ts), вакансії з кешованого звіту джерел, налаштування з кешу
 * (lib/admin/settings.ts). Кожен блок веде на свою докладну сторінку, якщо вона є.
 */

const TD = TD_TIGHT;
const TD_NUM = `${TD} text-right tabular-nums`;
const TH_NUM = `${TH_TIGHT} text-right`;
// Таблиця добірок у половині ширини: вужчі клітинки чисел, щоб усі 8 колонок вміщались без прокрутки.
const TD_DAY_NUM = "px-2 py-2.5 align-top text-right tabular-nums";
const TH_DAY_NUM =
  "border-b-2 border-ink px-2 py-2.5 text-right align-bottom font-display text-[0.9375rem] font-extrabold tracking-[0.02em] whitespace-nowrap";

const DAY_LABEL = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

const INTRO_LABELS: Record<string, string> = {
  pending: "Pending",
  accepted: "Accepted",
  direct: "Direct",
  declined: "Declined",
  expired: "Expired",
  canceled: "Canceled",
};

const X402_LABELS: Record<string, string> = {
  settled: "Settled",
  verified: "Verified",
  unconfirmed: "Unconfirmed",
  failed: "Failed",
};

type JobsResult = { report: JobSourcesReport | null; error: string | null };

function usd(cents: number): string {
  return `$${NUM.format(Math.round(cents / 100))}`;
}

function Flags({ flags }: { flags: Flag[] }) {
  if (flags.length === 0) {
    return (
      <p role="status" className="mt-6 rounded-lg border border-line bg-surface px-4 py-3 text-sm text-ink">
        Nothing needs attention right now.
      </p>
    );
  }
  return (
    <section aria-labelledby="attention-title" className="mt-6">
      <h2 id="attention-title" className="sr-only">
        Needs attention
      </h2>
      <ul className="grid gap-2">
        {flags.map((f, i) => (
          <li
            key={i}
            data-flag={f.level}
            className={cn(
              "flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-lg border bg-surface px-4 py-2.5 text-sm text-ink",
              f.level === "alert" ? "border-destructive/60 border-l-4 border-l-danger" : "border-line border-l-4 border-l-ink",
            )}
          >
            <span className="min-w-0 break-words">
              <span className={cn("mr-2 font-semibold", f.level === "alert" ? "text-danger" : "text-ink-muted")}>
                {f.level === "alert" ? "Alert" : "To do"}
              </span>
              {f.text}
            </span>
            {f.href ? (
              <Link href={f.href} className={cn(LINK, "inline-flex min-h-11 items-center")}>
                Open
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SettingsLine({ settings }: { settings: AppSettings }) {
  const item = (label: string, value: string, off: boolean) => (
    <span className="whitespace-nowrap">
      {label}: <b className={off ? "text-danger" : "text-ink"}>{value}</b>
    </span>
  );
  return (
    <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-muted" data-settings="">
      {item("Candidate sign-ups", settings.signups_open ? "open" : "closed", !settings.signups_open)}
      {item("Company sign-ups", settings.company_signups_open ? "open" : "closed", !settings.company_signups_open)}
      {item("Site notice", settings.banner_message ? settings.banner_level : "off", false)}
      <Link href="/admin/settings" className={cn(LINK, "inline-flex min-h-11 items-center")}>
        Settings
      </Link>
    </p>
  );
}

function Candidates({ o }: { o: Overview }) {
  const c = o.candidates;
  const funnel: [string, number][] = [
    ["Signed up", c.total],
    ["Brief started", c.briefStarted],
    ["Brief done, scoring consent", c.briefDone],
    ["X verified", c.xVerified],
    ["Wallets added", c.wallets],
    ["Card created", c.cards],
    ["Visible to companies", c.visible],
  ];
  return (
    <Panel id="candidates" title="Candidates">
      <Stats className="sm:grid-cols-4">
        <Stat label="Total" value={NUM.format(c.total)} />
        <Stat label="Today" value={NUM.format(c.today)} note="Since 00:00 UTC" />
        <Stat label="7 days" value={NUM.format(c.d7)} />
        <Stat label="30 days" value={NUM.format(c.d30)} />
      </Stats>
      <div className="grid gap-2">
        <SubHead>Onboarding funnel</SubHead>
        <div className={BOARD}>
          <table className={TABLE} data-table="funnel">
            <thead>
              <tr>
                <th scope="col" className={TH_TIGHT}>Step</th>
                <th scope="col" className={TH_NUM}>People</th>
                <th scope="col" className={TH_NUM}>Of all</th>
              </tr>
            </thead>
            <tbody>
              {funnel.map(([label, n]) => (
                <tr key={label} className={TR}>
                  <th scope="row" className={`${TD} font-normal`}>{label}</th>
                  <td className={TD_NUM}>{NUM.format(n)}</td>
                  <td className={`${TD_NUM} text-ink-muted`}>{pct(n, c.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <Stats>
        <Stat label="Email only" value={NUM.format(c.emailOnly)} note="Sign-in method" />
        <Stat label="Telegram only" value={NUM.format(c.telegramOnly)} note="Sign-in method" />
        <Stat label="Both" value={NUM.format(c.both)} note="Email and Telegram" />
        <Stat label="Digest by Telegram" value={NUM.format(c.channelTelegram)} />
        <Stat label="Digest by email" value={NUM.format(c.channelEmail)} />
        <Stat label="Digest paused" value={NUM.format(c.paused)} />
      </Stats>
    </Panel>
  );
}

function Scores({ o }: { o: Overview }) {
  const s = o.scores;
  const q = s.quality;
  return (
    <Panel id="scores" title="Scores">
      <Stats>
        <Stat label="People with scores" value={NUM.format(s.usersScored)} />
        <Stat
          label="Queued"
          value={NUM.format(s.queued)}
          note={s.oldestQueuedAt !== null ? <>Oldest <Ago at={s.oldestQueuedAt} now={o.now} /></> : "Queue is empty"}
        />
        <Stat label="Running" value={NUM.format(s.running)} />
        <Stat label="Done in 24 h" value={NUM.format(s.done24h)} />
        <Stat label="Failed in 24 h" value={NUM.format(s.failed24h)} alert={s.failed24h > 0} />
        <Stat label="Engine last write" value={<Ago at={s.lastEngineAt} now={o.now} />} note="Score or finished job" />
      </Stats>
      <div className="grid gap-2">
        <SubHead>Formula versions in use</SubHead>
        {s.versions.length === 0 ? (
          <p className="text-sm text-ink-muted">No scores yet.</p>
        ) : (
          <ul className="grid gap-1 text-sm" data-list="versions">
            {s.versions.map((v) => (
              <li key={v.version} className="flex flex-wrap gap-x-2">
                <span className="font-mono font-semibold">{v.version}</span>
                <span>{NUM.format(v.users)} people</span>
                <span className={v.published ? "text-ink-muted" : "font-semibold text-danger"}>
                  {v.published ? "shown to companies" : "hidden from companies: no passed quality run"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="grid gap-2">
        <SubHead>Last quality run</SubHead>
        {q ? (
          <p className="text-sm" data-quality="">
            <span className="font-mono font-semibold">{q.version}</span>: {q.nearPct.toFixed(1)}% within a band,{" "}
            {q.exactPct.toFixed(1)}% exact, {NUM.format(q.people)} people.{" "}
            <b className={q.passed ? "text-ink" : "text-danger"}>{q.passed ? "Passed" : "Not passed"}</b>,{" "}
            <Ago at={q.runAt} now={o.now} />.
          </p>
        ) : (
          <p className="text-sm text-ink-muted">No quality run recorded.</p>
        )}
      </div>
    </Panel>
  );
}

function Digests({ o }: { o: Overview }) {
  const d = o.digests;
  const week = d.days.reduce(
    (t, x) => ({ sent: t.sent + x.sent, failed: t.failed + x.failed, telegram: t.telegram + x.telegram, email: t.email + x.email }),
    { sent: 0, failed: 0, telegram: 0, email: 0 },
  );
  return (
    <Panel id="digests" title="Daily digests">
      <Stats className="sm:grid-cols-4">
        <Stat label="Can get a digest" value={NUM.format(d.eligible)} note="Roles, a score, not paused" />
        <Stat label="Due next run" value={NUM.format(d.dueNext)} note={`${CLOCK.format(d.nextRunAt)} UTC`} />
        <Stat label="Newest run" value={<Ago at={d.newestRunAt} now={o.now} />} />
        <Stat label="Stuck pending" value={NUM.format(d.stuckPending)} alert={d.stuckPending > 0} />
      </Stats>
      <div className={BOARD}>
        <table className={`${TABLE} min-w-[460px]`} data-table="digests">
          <caption className="px-3 pt-2.5 text-left text-xs text-ink-muted">
            Last 7 days, UTC. Sent this week: {NUM.format(week.telegram)} by Telegram, {NUM.format(week.email)} by email.
          </caption>
          <thead>
            <tr>
              <th scope="col" className={TH_TIGHT}>Day</th>
              <th scope="col" className={TH_DAY_NUM}>Runs</th>
              <th scope="col" className={TH_DAY_NUM}>Sent</th>
              <th scope="col" className={TH_DAY_NUM}>Failed</th>
              <th scope="col" className={TH_DAY_NUM}>Empty</th>
              <th scope="col" className={TH_DAY_NUM}><abbr title="Telegram" className="no-underline">TG</abbr></th>
              <th scope="col" className={TH_DAY_NUM}>Email</th>
              <th scope="col" className={TH_DAY_NUM}>Jobs</th>
            </tr>
          </thead>
          <tbody>
            {d.days.map((x) => (
              <tr key={x.day} className={TR} data-day={x.day}>
                <th scope="row" className={`${TD} font-normal whitespace-nowrap`}>{DAY_LABEL.format(Date.parse(`${x.day}T12:00:00Z`))}</th>
                <td className={TD_DAY_NUM}>{NUM.format(x.runs)}</td>
                <td className={TD_DAY_NUM}>{NUM.format(x.sent)}</td>
                <td className={cn(TD_DAY_NUM, x.failed > 0 && "font-semibold text-danger")}>{NUM.format(x.failed)}</td>
                <td className={TD_DAY_NUM}>{NUM.format(x.empty)}</td>
                <td className={TD_DAY_NUM}>{NUM.format(x.telegram)}</td>
                <td className={TD_DAY_NUM}>{NUM.format(x.email)}</td>
                <td className={TD_DAY_NUM}>{NUM.format(x.jobsSent)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-2">
        <SubHead>Top failure reasons, 7 days</SubHead>
        {d.failureReasons.length === 0 ? (
          <p className="text-sm text-ink-muted">No failed digests this week.</p>
        ) : (
          <ul className="grid gap-1 text-sm" data-list="failures">
            {d.failureReasons.map((r) => (
              <li key={r.reason} className="flex gap-3">
                <span className="w-10 shrink-0 text-right font-semibold tabular-nums">{NUM.format(r.n)}</span>
                <span className="min-w-0 break-words text-ink-muted">{r.reason}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

function Companies({ o }: { o: Overview }) {
  const c = o.companies;
  const intros = Object.entries(c.intros).sort((a, b) => b[1] - a[1]);
  return (
    <Panel
      id="companies"
      title="Companies"
      links={[
        { href: "/admin/companies", label: "Companies" },
        { href: "/admin/agency-applications", label: "Agencies" },
        { href: "/admin/jobs", label: "Jobs" },
      ]}
    >
      <Stats>
        <Stat label="Trial" value={NUM.format(c.trial)} />
        <Stat label="Subscribed" value={NUM.format(c.subscribed)} />
        <Stat label="Pay per request" value={NUM.format(c.payPerRequest)} note="Active, no subscription" />
        <Stat label="Agencies to review" value={NUM.format(c.agenciesPending)} note={`${NUM.format(c.pendingReview)} in review`} />
        <Stat label="Suspended" value={NUM.format(c.suspended)} />
        <Stat label="Closed or rejected" value={NUM.format(c.closed)} />
        <Stat label="Team members" value={NUM.format(c.members)} note={`${NUM.format(c.invitesOpen)} open invites`} />
      </Stats>
      <div className="grid gap-2">
        <SubHead>Last 7 days</SubHead>
        <Stats>
          <Stat label="Searches" value={NUM.format(c.searches7d)} note="Result pages" />
          <Stat label="Profile views" value={NUM.format(c.views7d)} />
          <Stat label="Intro requests" value={NUM.format(c.intros7d)} />
        </Stats>
      </div>
      <div className="grid gap-2">
        <SubHead>Intros by status, all time</SubHead>
        {intros.length === 0 ? (
          <p className="text-sm text-ink-muted">No intros yet.</p>
        ) : (
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm" data-list="intros">
            {intros.map(([status, n]) => (
              <span key={status} className="whitespace-nowrap">
                {INTRO_LABELS[status] ?? status}: <b>{NUM.format(n)}</b>
              </span>
            ))}
          </p>
        )}
      </div>
      <Stats>
        <Stat label="Open company jobs" value={NUM.format(c.openJobs)} note={`${NUM.format(c.liveJobs)} live in digests`} />
        <Stat label="Apply clicks" value={NUM.format(c.applyClicksTotal)} note="All time: no daily history is stored" />
        <Stat label="X queue" value={<Link href="/admin/x-queue" className={LINK}>{NUM.format(c.xQueue)}</Link>} />
      </Stats>
    </Panel>
  );
}

function Payments({ o }: { o: Overview }) {
  const p = o.payments;
  const statuses = ["settled", "verified", "unconfirmed", "failed"];
  return (
    <Panel id="payments" title="Payments" links={[{ href: "/admin/payments", label: "Payments" }]}>
      <Stats>
        <Stat label="Settled x402" value={usd(p.settledCents)} note={`${NUM.format(p.x402.settled ?? 0)} payments`} />
        <Stat label="Paid, no result" value={NUM.format(p.noResultWaiting)} note="Waiting for a refund" alert={p.noResultWaiting > 0} />
        <Stat label="Stuck x402" value={NUM.format(p.stale)} note="Verified over 5 min, or unconfirmed" alert={p.stale > 0} />
      </Stats>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm" data-list="x402">
        <span className="text-ink-muted">x402 by status:</span>
        {statuses.map((s) => (
          <span key={s} className="whitespace-nowrap">
            {X402_LABELS[s]}: <b>{NUM.format(p.x402[s] ?? 0)}</b>
          </span>
        ))}
      </p>
      <div className="grid gap-2">
        <SubHead>Subscriptions</SubHead>
        {p.subscriptions.length === 0 ? (
          <p className="text-sm text-ink-muted">No subscriptions yet.</p>
        ) : (
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm" data-list="subscriptions">
            {p.subscriptions.map((s) => (
              <span key={`${s.provider}:${s.status}`} className="whitespace-nowrap">
                {s.provider === "stripe" ? "Stripe" : s.provider === "usdc" ? "USDC" : "Manual"} {s.status}: <b>{NUM.format(s.n)}</b>
              </span>
            ))}
          </p>
        )}
      </div>
    </Panel>
  );
}

function Jobs({ report, error, now }: { report: JobSourcesReport | null; error: string | null; now: number }) {
  return (
    <Panel id="jobs" title="Jobs" links={[{ href: "/admin/sources", label: "Job sources" }]}>
      {error !== null ? (
        <p role="alert" className="text-sm text-ink">
          Could not read the job sources: {error}
        </p>
      ) : report ? (
        <>
          <Stats className="sm:grid-cols-4">
            <Stat
              label="Live web3 jobs"
              value={NUM.format(report.totals.liveJobs)}
              note={`${NUM.format(report.totals.nextroleLiveJobs)} NextRole, ${NUM.format(report.totals.companyLiveJobs)} companies`}
            />
            <Stat label="Active sources" value={NUM.format(report.totals.activeSources)} note={`In the last ${STALE_AFTER_SCANS} scans`} />
            <Stat
              label="Stale sources"
              value={NUM.format(report.totals.staleSources)}
              note={`Missed ${STALE_AFTER_SCANS} scans`}
              alert={report.totals.staleSources > 0}
            />
            <Stat
              label="Newest scan"
              value={<Ago at={report.totals.lastScan?.at ?? null} now={now} />}
              note={report.totals.lastScan?.status ?? undefined}
              alert={report.totals.scannerStale}
            />
          </Stats>
          <p className="text-xs text-ink-muted" data-hint="weekend">
            The live pool drops on weekends because the NextRole scanner does not run: it scans on weekdays at {SCAN_TIME_UTC},
            and a job stays live {LIVE_WINDOW_DAYS} days after the last scan saw it.
          </p>
          <p className="text-xs text-ink-muted">
            From the job sources report, counted <Ago at={report.computedAt} now={now} /> and cached for 10 min.
          </p>
        </>
      ) : null}
    </Panel>
  );
}

function Health({ o, report }: { o: Overview; report: JobSourcesReport | null }) {
  const cron = o.cron;
  return (
    <Panel id="health" title="Health">
      <Stats className="sm:grid-cols-3">
        <Stat label="Scoring engine" value={<Ago at={o.scores.lastEngineAt} now={o.now} />} note="Last write" />
        <Stat label="Digest engine" value={<Ago at={o.digests.newestRunAt} now={o.now} />} note="Newest digest run" />
        <Stat label="NextRole scanner" value={<Ago at={report?.totals.lastScan?.at ?? null} now={o.now} never="unknown" />} note="Newest scan" />
      </Stats>
      {cron.available ? null : (
        <p role="alert" className="text-sm text-ink">
          {cron.error}
        </p>
      )}
      <div className={BOARD}>
        <table className={`${TABLE} min-w-[440px]`} data-table="cron">
          <thead>
            <tr>
              <th scope="col" className={TH_TIGHT}>Cron job</th>
              <th scope="col" className={TH_TIGHT}>Last run</th>
              <th scope="col" className={TH_TIGHT}>Status</th>
              <th scope="col" className={TH_NUM}>Took</th>
              <th scope="col" className={TH_NUM}>Fails 24 h</th>
            </tr>
          </thead>
          <tbody>
            {cron.jobs.map((j) => (
              <tr key={j.job} className={TR} data-job={j.job} data-late={j.late ? "" : undefined}>
                <th scope="row" className={`${TD} font-normal whitespace-nowrap`}>
                  <span className="font-mono text-xs">{j.job}</span>
                  <span className="block font-mono text-xs text-ink-muted">{j.cron}</span>
                </th>
                <td className={`${TD} whitespace-nowrap`}>
                  <Ago at={j.lastAt} now={o.now} never="no run recorded" />
                </td>
                <td className={TD}>
                  {j.late ? (
                    <span className="text-xs font-semibold text-danger">Late</span>
                  ) : j.ok === null ? (
                    <span className="text-xs text-ink-muted">Unknown</span>
                  ) : j.ok ? (
                    <span className="text-xs text-ink-muted">OK</span>
                  ) : (
                    <span className="text-xs font-semibold text-danger" title={j.error ?? undefined}>
                      Failed
                    </span>
                  )}
                  {j.ok === false && j.error ? <div className="max-w-60 truncate text-xs text-ink-muted" title={j.error}>{j.error}</div> : null}
                </td>
                <td className={`${TD_NUM} whitespace-nowrap`}>{j.ms === null ? "" : j.ms < 1000 ? `${j.ms} ms` : `${(j.ms / 1000).toFixed(1)} s`}</td>
                <td className={cn(TD_NUM, j.failed24h > 0 && "font-semibold text-danger")}>{NUM.format(j.failed24h)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export default async function AdminOverviewPage() {
  if (!(await currentAdmin())) notFound();

  const main = db();
  const [overview, settings, jobs] = await Promise.all([
    loadOverview(main),
    getSettings(main),
    cachedJobSourcesReport((now) => loadJobSourcesReport(jobsDb(), main, now)).then(
      (report): JobsResult => ({ report, error: null }),
      (e: unknown): JobsResult => ({ report: null, error: e instanceof Error ? e.message : String(e) }),
    ),
  ]);
  const { report, error: jobsError } = jobs;
  const flags = overviewFlags(overview, jobs);
  const now = overview.now;

  return (
    <section className="mx-auto max-w-6xl px-[clamp(16px,4vw,56px)] pt-8 pb-20 sm:pt-12">
      <AdminNav current="/admin" />
      <h1 className="display text-title">Overview</h1>
      <p className="mt-2 max-w-prose text-sm text-ink-muted">
        Live counts from the database as of {CLOCK.format(now)} UTC. Reload to recount.
      </p>
      <SettingsLine settings={settings} />
      <Flags flags={flags} />

      <div className="mt-8 grid items-start gap-6 lg:grid-cols-2">
        <Candidates o={overview} />
        <div className="grid gap-6">
          <Scores o={overview} />
          <Jobs report={report} error={jobsError} now={now} />
        </div>
        <Digests o={overview} />
        <Companies o={overview} />
        <Payments o={overview} />
        <Health o={overview} report={report} />
      </div>

      <p className="mt-8 text-xs text-ink-muted" data-cost="">
        This page ran {overview.statements} database statements in one batch
        {overview.rowsRead !== null ? `, ${NUM.format(overview.rowsRead)} rows read` : ""}, plus the cached job sources report.
      </p>
    </section>
  );
}
