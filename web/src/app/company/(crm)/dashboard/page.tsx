import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { CARD, H2, H3, LINK, NoAccess, PAGE, PageTitle } from "@/components/crm/ui";
import { readAction } from "@/lib/crm/actions";
import { expiresInText, STAGE_ORDER, STAGE_TEXT } from "@/lib/crm/labels";
import { NOT_REACHED_TEXT } from "@/lib/crm/notify";
import type { Account } from "@/lib/crm/types";
import { loadDashboard, recentActivity } from "@/lib/crm/views";
import { crmPage } from "../crm";

export const metadata: Metadata = { title: "Dashboard", robots: { index: false } };

const TIME = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function when(iso: string, now: Date): string {
  const d = new Date(iso);
  const sameDay = d.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
  if (sameDay) return `${TIME.format(d)} UTC`;
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10) === d.toISOString().slice(0, 10);
  return yesterday ? "Yesterday" : DAY.format(d);
}

function Tile({ id, title, children, action }: { id: string; title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section aria-labelledby={id} className={`${CARD} grid grid-rows-[auto_1fr_auto] gap-3 p-4`}>
      <h2 id={id} className={`${H3} border-b-2 border-ink pb-2`}>
        {title}
      </h2>
      <div className="grid content-start gap-1 text-sm">{children}</div>
      {action ? <div className="pt-1">{action}</div> : null}
    </section>
  );
}

const QUOTA_ROWS: { key: string; label: string }[] = [
  { key: "search_candidates", label: "Search pages" },
  { key: "get_candidate", label: "Profiles" },
  { key: "request_intro_day", label: "Intros" },
  { key: "request_intro_month", label: "Intros this month" },
];

/**
 * Дашборд (специфікація 10.2 W1): воронка по етапах, знайомства, що чекають
 * (найближче прострочення), нові збіги збережених пошуків, живі вакансії,
 * використання сьогодні, останні 10 подій воронки. Нова компанія бачить три кроки.
 */
export default async function DashboardPage() {
  const { ctx, company } = await crmPage("dashboard");
  if (company.access === "none") {
    return (
      <div className={`${PAGE} max-w-5xl`}>
        <PageTitle>Dashboard</PageTitle>
        <NoAccess />
      </div>
    );
  }
  const [board, activity, account] = await Promise.all([
    loadDashboard(ctx),
    recentActivity(ctx, 10),
    readAction("get_account", {}, ctx).then((out) => out as Account),
  ]);
  const fresh = board.total === 0 && board.savedSearches.total === 0 && board.jobs.length === 0;

  return (
    <div className={`${PAGE} max-w-5xl`}>
      <PageTitle>Dashboard</PageTitle>

      {fresh ? (
        <section aria-labelledby="start-title" className={`${CARD} grid gap-4 p-4 sm:p-6`}>
          <h2 id="start-title" className={H2}>
            Get started
          </h2>
          <ol className="grid gap-3 sm:grid-cols-3">
            <li className="grid content-start gap-1 border-t-2 border-ink pt-3">
              <p className="font-semibold text-ink">1. Find candidates</p>
              <p className="text-sm text-ink-muted">Search anonymous profiles by role, score, chains and work mode.</p>
              <Link href="/company/search" className={`${LINK} text-sm`}>
                Open Search
              </Link>
            </li>
            <li className="grid content-start gap-1 border-t-2 border-ink pt-3">
              <p className="font-semibold text-ink">2. Save a search</p>
              <p className="text-sm text-ink-muted">Get a daily email when new candidates match your filters.</p>
              <Link href="/company/saved-searches" className={`${LINK} text-sm`}>
                Saved searches
              </Link>
            </li>
            <li className="grid content-start gap-1 border-t-2 border-ink pt-3">
              <p className="font-semibold text-ink">3. Post a job</p>
              <p className="text-sm text-ink-muted">Jobs you publish appear in daily digests of matching candidates.</p>
              <Link href="/company/jobs/new" className={`${LINK} text-sm`}>
                New job
              </Link>
            </li>
          </ol>
        </section>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          id="tile-pipeline"
          title="Pipeline"
          action={
            <Link href="/company/pipeline" className={`${LINK} text-sm`}>
              Open pipeline
            </Link>
          }
        >
          <dl className="grid gap-1">
            {STAGE_ORDER.map((s) => (
              <div key={s} className="flex justify-between gap-2">
                <dt className="text-ink-muted">{STAGE_TEXT[s]}</dt>
                <dd className="font-display text-base leading-tight font-extrabold tabular-nums text-ink">{board.counts[s]}</dd>
              </div>
            ))}
          </dl>
        </Tile>
        <Tile
          id="tile-intros"
          title="Intros waiting"
          action={
            <Link href="/company/pipeline/intros?status=pending" className={`${LINK} text-sm`}>
              View intros
            </Link>
          }
        >
          <p className="text-ink">
            <span className="font-display text-[2.5rem] leading-none font-black tabular-nums">{board.intros.pending}</span> pending
          </p>
          {board.intros.nextExpiry ? <p className="text-ink-muted">Next: {expiresInText(board.intros.nextExpiry, ctx.now).toLowerCase()}</p> : null}
          {board.intros.notReached ? (
            <p className="text-ink-muted">
              {board.intros.notReached === 1 ? NOT_REACHED_TEXT : `We could not reach ${board.intros.notReached} candidates yet.`}
            </p>
          ) : null}
        </Tile>
        <Tile
          id="tile-matches"
          title="New matches"
          action={
            <Link href="/company/saved-searches" className={`${LINK} text-sm`}>
              Open saved searches
            </Link>
          }
        >
          {board.savedSearches.total === 0 ? (
            <p className="text-ink-muted">No saved searches yet.</p>
          ) : board.savedSearches.newMatches > 0 ? (
            <p className="text-ink">
              {board.savedSearches.newMatches} new in {board.savedSearches.withNew} {board.savedSearches.withNew === 1 ? "saved search" : "saved searches"}
            </p>
          ) : (
            <p className="text-ink-muted">No new matches in the last day.</p>
          )}
          {board.savedSearches.total ? (
            <p className="text-ink-muted">
              {board.savedSearches.total} saved, {board.savedSearches.alerts} with a daily alert
            </p>
          ) : null}
        </Tile>
        <Tile id="tile-usage" title="Usage today">
          <dl className="grid gap-1">
            {QUOTA_ROWS.map(({ key, label }) => {
              const q = account.quotas[key];
              if (!q || q.limit === null || q.remaining === null) return null;
              return (
                <div key={key} className="flex justify-between gap-2">
                  <dt className="text-ink-muted">{label}</dt>
                  <dd className="font-display text-base leading-tight font-extrabold tabular-nums text-ink">
                    {q.limit - q.remaining}/{q.limit}
                  </dd>
                </div>
              );
            })}
          </dl>
          <p className="text-xs text-ink-muted">Daily limits reset at 00:00 UTC.</p>
        </Tile>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section aria-labelledby="activity-title" className={`${CARD} grid content-start gap-3 p-4`}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="activity-title" className={H3}>
              Recent activity
            </h2>
            <Link href="/company/settings#activity-title" className={`${LINK} text-sm`}>
              Full activity log
            </Link>
          </div>
          {activity.length === 0 ? (
            <p className="text-sm text-ink-muted">Nothing yet. Changes in your pipeline show up here.</p>
          ) : (
            <ol className="grid gap-2">
              {activity.map((a) => (
                <li key={a.id} className="grid gap-0.5 border-b border-line pb-2 text-sm last:border-b-0 sm:grid-cols-[1fr_auto] sm:gap-4">
                  <span className="break-words text-ink">
                    <Link href={`/company/candidates/${a.candidateId}`} prefetch={false} className="underline decoration-line underline-offset-4 hover:decoration-brand">
                      {a.text}
                    </Link>
                  </span>
                  <time dateTime={a.at} className="font-mono text-xs text-ink-muted">
                    {when(a.at, ctx.now)}
                  </time>
                </li>
              ))}
            </ol>
          )}
        </section>
        <section aria-labelledby="jobs-title" className={`${CARD} grid content-start gap-3 p-4`}>
          <h2 id="jobs-title" className={H3}>
            Live jobs
          </h2>
          {board.jobs.length === 0 ? (
            <p className="text-sm text-ink-muted">No jobs yet. Jobs you publish appear in daily digests of matching candidates.</p>
          ) : (
            <ul className="grid gap-2">
              {board.jobs.map((j) => (
                <li key={j.id} className="grid gap-0.5 text-sm">
                  <span className="font-semibold break-words text-ink">
                    <Link href={`/company/jobs/${j.id}`} className="underline decoration-line underline-offset-4 hover:decoration-brand">
                      {j.title}
                    </Link>
                    {j.status === "draft" ? <span className="font-normal text-ink-muted"> (draft)</span> : null}
                    {j.status === "open" && !j.live ? <span className="font-normal text-ink-muted"> (not live)</span> : null}
                  </span>
                  {j.status === "open" ? (
                    <span className="text-ink-muted">
                      {j.digestShown} shown in digests, {j.applyClicks} {j.applyClicks === 1 ? "click" : "clicks"}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
