import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { AdminNav } from "@/components/admin-nav";
import { Ago, CLOCK, NUM, Panel, Stat, Stats, SubHead } from "@/components/admin-ui";
import { BOARD, TABLE, TD_TIGHT, TH_TIGHT, TR } from "@/components/board";
import { SubmitButton } from "@/components/form/submit-button";
import { recentAlerts, type RecentAlert } from "@/lib/admin/alerts";
import { DEMO_CANDIDATES, DEMO_COMPANY_NAME, demoState, type DemoState } from "@/lib/admin/demo";
import { cachedJobSourcesReport, loadJobSourcesReport, type JobSourcesReport } from "@/lib/admin/job-sources";
import { loadOverview, type Overview } from "@/lib/admin/overview";
import { WEEKLY_HOUR_UTC } from "@/lib/admin/weekly";
import { currentAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { jobsDb } from "@/lib/jobs-db";
import { cn } from "@/lib/utils";
import { createDemoAction, deleteDemoAction, openDemoAction, sendWeeklyNowAction } from "../actions";

export const metadata: Metadata = { title: "Health", robots: { index: false } };

/**
 * /admin/health: усе службове, що раніше жило під «More stats» на головній. Головна лишає
 * тільки те, що чекає на власника, і цифри сайту; сюди переїхали рушії, розклад cron, добірки,
 * сповіщення власнику й демо-компанія.
 */

const TD = TD_TIGHT;
const TD_NUM = `${TD} text-right tabular-nums`;
const TH_NUM = `${TH_TIGHT} text-right`;
const TD_DAY_NUM = "px-2 py-2.5 align-top text-right tabular-nums";
const TH_DAY_NUM =
  "border-b-2 border-ink px-2 py-2.5 text-right align-bottom font-display text-[0.9375rem] font-extrabold tracking-[0.02em] whitespace-nowrap";

const DAY_LABEL = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });


function Health({ o, report }: { o: Overview; report: JobSourcesReport | null }) {
  const cron = o.cron;
  return (
    <Panel id="health" title="Health">
      <Stats className="sm:grid-cols-3">
        <Stat label="Scoring engine" value={<Ago at={o.scores.lastEngineAt} now={o.now} />} note="Last write" />
        <Stat label="Digest engine" value={<Ago at={o.digests.newestRunAt} now={o.now} />} note="Newest digest run" />
        <Stat label="Job scanner" value={<Ago at={report?.totals.lastScan?.at ?? null} now={o.now} never="unknown" />} note="Newest scan" />
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


const KIND_LABELS: Record<string, string> = {
  agency: "Agency",
  cron: "Cron",
  payments: "Payments",
  digest: "Digest",
  scan: "Scanner",
  source: "Sources",
  discover: "Discovery",
  weekly: "Weekly report",
};

function Owner({ alerts, now, status }: { alerts: RecentAlert[]; now: number; status: ReactNode }) {
  return (
    <Panel id="owner" title="Alerts to you">
      <p className="text-sm text-ink">
        You get a Telegram message from the bot (or an email, if your account has no Telegram) when an agency applies, a
        job source or a scan fails, a scheduled job fails, a payment needs a refund, or digests start failing. Each
        message says what happened, why it matters and what to do. The same alert comes at most once a day.
      </p>
      <div className="grid gap-2">
        <SubHead>Weekly report</SubHead>
        <p className="text-sm text-ink-muted">
          Every Monday at {String(WEEKLY_HOUR_UTC).padStart(2, "0")}:00 UTC, by Telegram and email: visitors, new people,
          brief completion, digests, companies and intros, what waits for you, and problems.
        </p>
        <form action={sendWeeklyNowAction} className="flex flex-wrap items-center gap-3">
          <SubmitButton variant="outline" className="h-11 px-4" pendingLabel="Sending...">
            Send this week&apos;s report now
          </SubmitButton>
        </form>
        {status}
      </div>
      <div className="grid gap-2">
        <SubHead>Last alerts</SubHead>
        {alerts.length === 0 ? (
          <p className="text-sm text-ink-muted">No alerts sent yet.</p>
        ) : (
          <ul className="grid gap-1.5 text-sm" data-list="alerts">
            {alerts.map((a) => (
              <li key={a.key} className="grid gap-0.5">
                <span className="min-w-0 break-words">
                  <span className="mr-2 text-xs font-semibold text-ink-muted uppercase">{KIND_LABELS[a.kind] ?? a.kind}</span>
                  {a.summary ?? a.key}
                </span>
                <span className="text-xs text-ink-muted">
                  <Ago at={a.sentAt} now={now} />
                  {a.times > 1 ? `, ${a.times} times` : ""}
                  {a.channel ? `, by ${a.channel.replace(",", " and ")}` : ""}
                  {a.error ? <span className="text-danger">, not delivered: {a.error}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}


function Demo({ demo, status }: { demo: DemoState; status: ReactNode }) {
  const mine = demo.companies.find((c) => c.ownerIsYou);
  return (
    <Panel id="demo" title="Demo company">
      <p className="text-sm text-ink">
        Test the company side without a real company. {DEMO_COMPANY_NAME} is owned by you, has a free trial, and sees{" "}
        {DEMO_CANDIDATES.length} synthetic candidates with different roles, scores and levels.
        Real companies never see them, they get no digests and are not counted anywhere. Intros to them are answered
        by themselves a few seconds later, or you answer for them with a button on the candidate page.
      </p>
      {!demo.formula.published ? (
        <p role="status" className="text-sm text-danger">
          No formula has passed the quality check yet, so demo scores show as not published, like real ones.
        </p>
      ) : null}
      <p className="text-sm text-ink-muted" data-demo="">
        {demo.companies.length === 0
          ? "No demo company yet."
          : `${demo.companies.map((c) => c.name).join(", ")}: ${NUM.format(demo.candidates)} demo candidates, ${NUM.format(demo.intros)} intros.`}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        {mine ? (
          <form action={openDemoAction}>
            <input type="hidden" name="company_id" value={mine.id} />
            <SubmitButton className="h-11 px-4" pendingLabel="Opening...">
              Open {DEMO_COMPANY_NAME}
            </SubmitButton>
          </form>
        ) : (
          <form action={createDemoAction}>
            <SubmitButton className="h-11 px-4" pendingLabel="Creating...">
              Create demo company
            </SubmitButton>
          </form>
        )}
        {demo.companies.length > 0 || demo.candidates > 0 ? (
          <form action={deleteDemoAction}>
            <SubmitButton variant="outline" className="h-11 px-4 text-danger" pendingLabel="Deleting...">
              Delete demo data
            </SubmitButton>
          </form>
        ) : null}
      </div>
      {status}
    </Panel>
  );
}


type Search = { [key: string]: string | string[] | undefined };

/** Рядок про результат дії з адреси (?done=… або ?error=…). */
function statusFor(q: Search, area: "owner" | "demo"): ReactNode {
  const one = (k: string) => (Array.isArray(q[k]) ? q[k][0] : q[k]) ?? "";
  const done = one("done");
  const error = one("error");
  let text: string | null = null;
  let bad = false;
  if (area === "owner" && done === "weekly") {
    const ch = one("ch");
    text = `Report sent${ch ? ` by ${ch.replace(",", " and ")}` : ""}.${one("why") ? ` Not delivered everywhere: ${one("why")}` : ""}`;
  } else if (area === "owner" && error === "weekly") {
    bad = true;
    text = `Report not sent: ${one("why") || "unknown reason"}.`;
  } else if (area === "demo" && done === "demo_created") {
    text = one("existing") ? `Your demo company already exists; ${one("n")} demo candidates.` : `Demo company created with ${one("n")} demo candidates.`;
  } else if (area === "demo" && done === "demo_deleted") {
    text = `Deleted ${one("c")} demo companies and ${one("n")} demo candidates.`;
  } else if (area === "demo" && error === "demo_missing") {
    bad = true;
    text = "That demo company is gone. Create it again.";
  }
  if (!text) return null;
  return (
    <p role={bad ? "alert" : "status"} className={cn("text-sm", bad ? "text-danger" : "text-brand")}>
      {text}
    </p>
  );
}

export default async function AdminHealthPage({ searchParams }: { searchParams: Promise<Search> }) {
  const admin = await currentAdmin();
  if (!admin) notFound();
  const query = await searchParams;
  const main = db();
  const [overview, report, alerts, demo] = await Promise.all([
    loadOverview(main),
    cachedJobSourcesReport((now) => loadJobSourcesReport(jobsDb(), main, now)).then(
      (r) => r,
      () => null,
    ),
    recentAlerts(main),
    demoState(main, admin.id),
  ]);

  return (
    <section className="mx-auto max-w-6xl px-[clamp(16px,4vw,56px)] pt-8 pb-20 sm:pt-12">
      <AdminNav current="/admin/health" viewAsCompanyId={demo.companies.find((c) => c.ownerIsYou)?.id ?? null} />
      <h1 className="display text-title">Health</h1>
      <p className="mt-2 max-w-prose text-sm text-ink-muted">
        Engines, scheduled jobs, digests and the alerts you get. Everything here is about whether the site works, not
        about how it is doing: the numbers live on Overview.
      </p>

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-2">
        <Health o={overview} report={report} />
        <Scores o={overview} />
        <Digests o={overview} />
        <Owner alerts={alerts} now={overview.now} status={statusFor(query, "owner")} />
        <Demo demo={demo} status={statusFor(query, "demo")} />
      </div>
    </section>
  );
}
