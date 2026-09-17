import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminNav } from "@/components/admin-nav";
import { BucketTabs, VisitsChart } from "@/components/admin-chart";
import { Ago, CLOCK, LINK, NUM, Panel, Stat, Stats, SubHead } from "@/components/admin-ui";
import { BOARD, TABLE, TD_TIGHT, TH_TIGHT, TR } from "@/components/board";
import { cachedJobSourcesReport, loadJobSourcesReport, type JobSourcesReport } from "@/lib/admin/job-sources";
import { listCandidates, type CandidateRow } from "@/lib/admin/scores";
import { demoState } from "@/lib/admin/demo";
import { loadOverview, overviewFlags, type Flag, type Overview } from "@/lib/admin/overview";
import { getSettings, type AppSettings } from "@/lib/admin/settings";
import {
  conversion,
  GROUP_LABELS,
  isVisitBucket,
  loadVisitSeries,
  loadVisits,
  type VisitBucket,
  type VisitReport,
  type VisitSeries,
} from "@/lib/analytics/visits";
import { currentAdmin } from "@/lib/auth/admin";
import { pendingContactMessages, type PendingContacts } from "@/lib/contact";
import { db } from "@/lib/db";
import { jobsDb } from "@/lib/jobs-db";
import { parseSavedStep, STANDOUT_STEPS } from "@/lib/onboarding/steps";
import { fromSqlTime } from "@/lib/time";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Admin overview", robots: { index: false } };

/**
 * Головна адмінки, одна панель на все (власник 17.09: «одна панель, де всі повідомлення, що
 * потребують моєї уваги, статистика по сайту, графік відвідувачів і платежі, якщо є»).
 *
 * Тут лише чотири речі:
 *   1. що чекає на власника: листи з /contact без відповіді (з текстом), заявки, черга X, збої;
 *   2. цифри сайту одним рядком;
 *   3. графік відвідувачів з кроком дні / тижні / місяці;
 *   4. оплати, лише якщо вони є, і нові люди.
 *
 * Усе службове (рушії, cron, добірки, сповіщення, демо) на /admin/health; розбір людей на
 * /admin/candidates, компанії на /admin/companies.
 */

const TD = TD_TIGHT;
const TD_NUM = `${TD} text-right tabular-nums`;
const TH_NUM = `${TH_TIGHT} text-right`;

const SHORT_DAY = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

const TOPIC_LABELS: Record<string, string> = {
  candidate: "Candidate",
  company: "Company",
  press: "Press",
  other: "Other",
};

function usd(cents: number): string {
  return `$${NUM.format(Math.round(cents / 100))}`;
}

/** Перший рядок листа: у панелі видно, про що він, повний текст у листі й у Messages. */
function firstLine(text: string, max = 180): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** Блок оплат має сенс, лише коли був хоч один платіж чи підписка. */
export function paymentsEmpty(o: Overview): boolean {
  const p = o.payments;
  const x402 = Object.values(p.x402).reduce((s, n) => s + n, 0);
  return p.settledCents === 0 && x402 === 0 && p.subscriptions.length === 0 && p.noResultWaiting === 0 && p.stale === 0;
}

/**
 * Що чекає на власника: спершу листи людей (від кого й про що видно одразу, без заходу в
 * Messages), потім збої й задачі з overviewFlags. Порожньо = один спокійний рядок.
 */
function Attention({ messages, flags, now }: { messages: PendingContacts; flags: Flag[]; now: number }) {
  const alerts = flags.filter((f) => f.level === "alert").length;
  const todo = flags.length - alerts + messages.total;
  const nothing = messages.total === 0 && flags.length === 0;
  return (
    <Panel
      id="attention"
      title="Needs you"
      className="mt-6"
      links={messages.total > 0 ? [{ href: "/admin/messages", label: "All messages" }] : []}
    >
      {nothing ? (
        <p role="status" className="text-sm text-ink">
          Nothing needs attention right now.
        </p>
      ) : (
        <p className="text-sm text-ink-muted" data-attention-count="">
          {alerts > 0 ? <b className="text-danger">{NUM.format(alerts)} broken</b> : "Nothing broken"}
          {todo > 0 ? <> and {NUM.format(todo)} waiting for you.</> : ", nothing waiting."}
        </p>
      )}

      {messages.newest.length > 0 ? (
        <ul className="grid gap-2" data-list="messages">
          {messages.newest.map((m) => (
            <li
              key={m.id}
              data-message={m.id}
              className="grid gap-1 rounded-lg border border-line border-l-4 border-l-ink bg-surface px-4 py-2.5 text-sm"
            >
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-xs font-semibold text-ink-muted uppercase">{TOPIC_LABELS[m.topic] ?? m.topic}</span>
                <b className="break-all">{m.email}</b>
                <span className="text-xs text-ink-muted">
                  <Ago at={fromSqlTime(m.createdAt).getTime()} now={now} />
                </span>
              </span>
              <span className="break-words text-ink">{firstLine(m.message)}</span>
              <span className="flex flex-wrap gap-x-4">
                <a href={`mailto:${m.email}?subject=${encodeURIComponent("Re: your message to NextCryptoJob")}`} className={LINK}>
                  Reply by email
                </a>
                <Link href="/admin/messages" className={LINK}>
                  Read it all and mark answered
                </Link>
              </span>
            </li>
          ))}
          {messages.total > messages.newest.length ? (
            <li className="text-sm text-ink-muted">
              {NUM.format(messages.total - messages.newest.length)} more unanswered in{" "}
              <Link href="/admin/messages" className={LINK}>
                Messages
              </Link>
              .
            </li>
          ) : null}
        </ul>
      ) : null}

      {flags.length > 0 ? (
        <ul className="grid gap-2" data-list="flags">
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
      ) : null}
    </Panel>
  );
}

/** Цифри сайту: люди, вакансії, відвідувачі. Кожна веде на свою сторінку через меню. */
function KeyNumbers({ o, report, visits }: { o: Overview; report: JobSourcesReport | null; visits: VisitReport }) {
  return (
    <Stats className="sm:grid-cols-3 lg:grid-cols-6">
      <Stat label="People" value={NUM.format(o.candidates.total)} note={`${NUM.format(o.candidates.today)} today`} />
      <Stat label="Cards" value={NUM.format(o.candidates.cards)} note={`${NUM.format(o.candidates.visible)} visible to companies`} />
      <Stat label="Jobs live" value={report ? NUM.format(report.totals.liveJobs) : "?"} note="Web3 jobs in the latest scan" />
      <Stat label="Visitors, 30 days" value={NUM.format(visits.totals.uniques)} note={`${NUM.format(visits.totals.views)} page views`} />
      <Stat label="Sign-ups, 30 days" value={NUM.format(visits.totals.signups)} />
      <Stat
        label="Visit to sign-up"
        value={conversion(visits.totals.signups, visits.totals.uniques)}
        note="Sign-ups per unique visitor"
      />
    </Stats>
  );
}

/** Графік і звідки люди приходять. Таблиця по днях під «Day by day»: потрібна нечасто. */
function Visitors({ series, visits, bucket }: { series: VisitSeries; visits: VisitReport; bucket: VisitBucket }) {
  return (
    <Panel id="visitors" title="Visitors" className="mt-6">
      {!series.available ? (
        <p role="status" className="text-sm text-ink-muted">
          {series.error ?? "No visit data yet."}
        </p>
      ) : null}
      <BucketTabs base="/admin" current={bucket} />
      <VisitsChart series={series} />
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="grid gap-2">
          <SubHead>Where visitors land</SubHead>
          {visits.pages.length === 0 ? (
            <p className="text-sm text-ink-muted">Nothing yet.</p>
          ) : (
            <ul className="grid gap-1 text-sm" data-list="pages">
              {visits.pages.map((p) => (
                <li key={p.key} className="flex justify-between gap-3">
                  <span className="min-w-0 break-words">{GROUP_LABELS[p.key] ?? p.key}</span>
                  <span className="shrink-0 tabular-nums text-ink-muted">
                    <b className="text-ink">{NUM.format(p.uniques)}</b> new, {NUM.format(p.views)} views
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="grid gap-2">
          <SubHead>Where they come from</SubHead>
          {visits.referrers.length === 0 ? (
            <p className="text-sm text-ink-muted">Nothing yet.</p>
          ) : (
            <ul className="grid gap-1 text-sm" data-list="referrers">
              {visits.referrers.map((r) => (
                <li key={r.key} className="flex justify-between gap-3">
                  <span className="min-w-0 font-mono text-xs break-all">{r.key === "direct" ? "Direct or unknown" : r.key}</span>
                  <span className="shrink-0 tabular-nums text-ink-muted">
                    <b className="text-ink">{NUM.format(r.uniques)}</b> visitors
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <details className="group">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand [&::-webkit-details-marker]:hidden">
          <span aria-hidden className="inline-block transition-transform group-open:rotate-90">
            {"›"}
          </span>
          Day by day, last 30 days
        </summary>
        <div className={`mt-4 ${BOARD} max-h-[26rem] overflow-y-auto`}>
          <table className={`${TABLE} min-w-[440px]`} data-table="visits">
            <thead>
              <tr>
                <th scope="col" className={TH_TIGHT}>Day</th>
                <th scope="col" className={TH_NUM}>Unique visitors</th>
                <th scope="col" className={TH_NUM}>Views</th>
                <th scope="col" className={TH_NUM}>Sign-ups</th>
                <th scope="col" className={TH_NUM}>Conv.</th>
              </tr>
            </thead>
            <tbody>
              {visits.days.map((d) => (
                <tr key={d.day} className={TR} data-day={d.day}>
                  <th scope="row" className={`${TD} font-normal whitespace-nowrap`}>{SHORT_DAY.format(Date.parse(`${d.day}T12:00:00Z`))}</th>
                  <td className={TD_NUM}>{NUM.format(d.uniques)}</td>
                  <td className={TD_NUM}>{NUM.format(d.views)}</td>
                  <td className={cn(TD_NUM, d.signups > 0 && "font-semibold")}>{NUM.format(d.signups)}</td>
                  <td className={`${TD_NUM} text-ink-muted`}>{d.uniques || d.signups ? conversion(d.signups, d.uniques) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <p className="text-xs text-ink-muted" data-hint="visits">
        Counted by the site itself: no third-party scripts, no cookies. A unique visitor is the same IP and browser on
        one UTC day, kept only as a salted hash until the next day, never as an IP. Bots and your own visits are not
        counted. Sign-ups are new accounts (email or Telegram).
      </p>
    </Panel>
  );
}

/** Оплати коротко; усе інше на /admin/payments. */
function Payments({ o }: { o: Overview }) {
  const p = o.payments;
  const subs = p.subscriptions.filter((s) => s.n > 0);
  return (
    <Panel id="payments" title="Payments" className="mt-6" links={[{ href: "/admin/payments", label: "All payments" }]}>
      <Stats className="sm:grid-cols-4">
        <Stat label="Settled x402" value={usd(p.settledCents)} note={`${NUM.format(p.x402.settled ?? 0)} payments`} />
        <Stat label="Paid, no result" value={NUM.format(p.noResultWaiting)} note="Waiting for a refund" alert={p.noResultWaiting > 0} />
        <Stat label="Stuck x402" value={NUM.format(p.stale)} note="Verified over 5 min, or unconfirmed" alert={p.stale > 0} />
        <Stat
          label="Subscriptions"
          value={NUM.format(subs.reduce((n, s) => n + s.n, 0))}
          note={subs.length > 0 ? subs.map((s) => `${s.provider} ${s.status}: ${s.n}`).join(", ") : "None yet"}
        />
      </Stats>
    </Panel>
  );
}

/** Скільки найновіших людей видно одразу (власник 16.09, b4: насамперед нові користувачі). */
export const NEW_USERS_SHOWN = 8;

const STEP_LABEL: Record<string, string> = {
  target: "Brief: own words",
  roles: "Brief: roles",
  place: "Brief: place and pay",
  delivery: "Brief: delivery",
  x: "Sources: X",
  wallets: "Sources: wallets",
  sources: "Sources: other",
  done: "Done",
};

/** Де людина зупинилась: крок анкети, на якому її збережено. */
function stepLabel(raw: string | null): string {
  const step = parseSavedStep(raw);
  if (step === "done") return STEP_LABEL.done!;
  const label = STEP_LABEL[step] ?? step;
  return (STANDOUT_STEPS as readonly string[]).includes(step) ? `Brief done. ${label}` : label;
}

/** Нові люди: хто, коли, де зупинився в анкеті, бал. Рядок веде на розбір балу. */
function NewUsers({ rows, now }: { rows: CandidateRow[]; now: number }) {
  return (
    <Panel id="new-users" title="New people" links={[{ href: "/admin/candidates", label: "All candidates" }]} className="mt-6">
      {rows.length === 0 ? (
        <p className="text-sm text-ink-muted">No sign-ups yet.</p>
      ) : (
        <div className={BOARD}>
          <table className={TABLE} data-table="new-users">
            <thead>
              <tr>
                <th scope="col" className={TH_TIGHT}>Person</th>
                <th scope="col" className={TH_TIGHT}>Signed up</th>
                <th scope="col" className={TH_TIGHT}>Where they are</th>
                <th scope="col" className={TH_NUM}>Best score</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.userId} className={TR}>
                  <td className={TD}>
                    <Link href={`/admin/scores/${r.userId}`} className={LINK}>
                      {r.email ?? (r.xHandle ? `@${r.xHandle}` : r.telegramUsername ? `@${r.telegramUsername}` : r.userId)}
                    </Link>
                    {r.xHandle && r.email ? <span className="text-ink-muted"> @{r.xHandle}</span> : null}
                  </td>
                  <td className={TD}>
                    <Ago at={r.createdAt ? fromSqlTime(r.createdAt).getTime() : null} now={now} never="-" />
                  </td>
                  <td className={TD}>{stepLabel(r.step)}</td>
                  <td className={TD_NUM}>{r.bestScore ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
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
      <Link href="/admin/health" className={cn(LINK, "inline-flex min-h-11 items-center")}>
        Health
      </Link>
    </p>
  );
}

type Search = { [key: string]: string | string[] | undefined };

export default async function AdminOverviewPage({ searchParams }: { searchParams: Promise<Search> }) {
  const admin = await currentAdmin();
  if (!admin) notFound();
  const query = await searchParams;
  const rawStep = Array.isArray(query.step) ? query.step[0] : query.step;
  const bucket: VisitBucket = isVisitBucket(rawStep) ? rawStep : "day";

  const main = db();
  const [overview, settings, jobs, visits, series, messages, demo, newUsers] = await Promise.all([
    loadOverview(main),
    getSettings(main),
    cachedJobSourcesReport((now) => loadJobSourcesReport(jobsDb(), main, now)).then(
      (report) => ({ report, error: null as string | null }),
      (e: unknown) => ({ report: null as JobSourcesReport | null, error: e instanceof Error ? e.message : String(e) }),
    ),
    loadVisits(main),
    loadVisitSeries(main, bucket),
    pendingContactMessages(main),
    demoState(main, admin.id),
    listCandidates(main, { limit: NEW_USERS_SHOWN }),
  ]);
  const { report } = jobs;
  const flags = overviewFlags(overview, jobs);
  const now = overview.now;

  return (
    <section className="mx-auto max-w-6xl px-[clamp(16px,4vw,56px)] pt-8 pb-20 sm:pt-12">
      <AdminNav current="/admin" viewAsCompanyId={demo.companies.find((c) => c.ownerIsYou)?.id ?? null} />
      <h1 className="display text-title">Overview</h1>
      <p className="mt-2 max-w-prose text-sm text-ink-muted">
        Everything waiting for you, and how the site is doing, as of {CLOCK.format(now)} UTC. Reload to recount.
      </p>
      <SettingsLine settings={settings} />

      <Attention messages={messages} flags={flags} now={now} />
      <div className="mt-6">
        <KeyNumbers o={overview} report={report} visits={visits} />
      </div>
      <Visitors series={series} visits={visits} bucket={bucket} />
      {paymentsEmpty(overview) ? null : <Payments o={overview} />}
      <NewUsers rows={newUsers} now={now} />

      <p className="mt-8 text-xs text-ink-muted" data-cost="">
        This page ran {overview.statements} database statements in one batch
        {overview.rowsRead !== null ? `, ${NUM.format(overview.rowsRead)} rows read` : ""}, plus the cached job sources report.
      </p>
    </section>
  );
}
