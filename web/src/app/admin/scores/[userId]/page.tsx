import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AdminNav } from "@/components/admin-nav";
import { NUM, Stat, Stats } from "@/components/admin-ui";
import { BOARD, TABLE, TD_TIGHT, TH_TIGHT, TR } from "@/components/board";
import { Button } from "@/components/ui/button";
import { loadUserScoreDetail } from "@/lib/admin/scores";
import { currentAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { fromSqlTime } from "@/lib/time";
import type { RoleView, SourceBar } from "@/lib/score/explain";
import { rescoreNowAction } from "../actions";

export const metadata: Metadata = { title: "Score inspector", robots: { index: false } };

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

const ERRORS: Record<string, string> = {
  not_admin: "Only admins can do this.",
  already_queued: "A score job is already queued for this person.",
  too_soon: "Wait a bit: this person's score was just requested.",
  no_consent: "This person has not given scoring consent, so nothing was queued.",
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function points(bar: SourceBar): string {
  return bar.value === null ? "-" : ((bar.weight * bar.value) / 100).toFixed(1);
}

function SourceTable({ title, bars, weightLabel }: { title: string; bars: SourceBar[]; weightLabel: string }) {
  if (bars.length === 0) return null;
  return (
    <div className="grid gap-2">
      <h3 className="font-display text-sm font-extrabold tracking-[0.02em] uppercase">{title}</h3>
      <div className={BOARD}>
        <table className={TABLE}>
          <thead>
            <tr>
              <th className={TH_TIGHT}>Source</th>
              <th className={`${TH_TIGHT} text-right`}>{weightLabel}</th>
              <th className={`${TH_TIGHT} text-right`}>Value</th>
              <th className={`${TH_TIGHT} text-right`}>Points</th>
            </tr>
          </thead>
          <tbody>
            {bars.map((b) => (
              <tr key={b.key} className={TR}>
                <td className={TD_TIGHT}>{b.label}</td>
                <td className={`${TD_TIGHT} text-right tabular-nums`}>{b.weight}</td>
                <td className={`${TD_TIGHT} text-right tabular-nums`}>{b.value ?? "-"}</td>
                <td className={`${TD_TIGHT} text-right tabular-nums`}>{points(b)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RoleBlock({ view }: { view: RoleView }) {
  return (
    <div className="grid gap-3 border-b border-line pb-6 last:border-b-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-xl font-extrabold">{view.name}</h2>
        {view.state === "scored" ? (
          <p className="text-sm text-ink-muted">
            Score {view.score}, level {view.level} of 10, cover {view.cover}%
          </p>
        ) : null}
      </div>
      {view.state === "waiting" ? <p className="text-sm text-ink-muted">Waiting for a score.</p> : null}
      {view.state === "unscored" ? <p className="text-sm text-ink-muted">{view.note}.</p> : null}
      {view.state === "missing" ? (
        <>
          <p className="text-sm text-ink">{view.reason}</p>
          {view.gaps.length > 0 ? (
            <ul className="grid gap-1 text-sm text-ink-muted">
              {view.gaps.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      {view.state === "scored" ? (
        <>
          <SourceTable title="Core" bars={view.core} weightLabel="Weight" />
          <SourceTable title="Bonus" bars={view.bonus} weightLabel="Max" />
          {view.reason ? <p className="text-sm text-ink-muted">{view.reason}</p> : null}
          {view.gaps.length > 0 ? (
            <ul className="grid gap-1 text-sm text-ink-muted">
              {view.gaps.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          ) : null}
          <p className="text-xs text-ink-muted">
            Formula {view.formulaVersion}, checked {DATE.format(new Date(view.computedAt.replace(" ", "T") + "Z"))}.
          </p>
        </>
      ) : null}
    </div>
  );
}

type Props = { params: Promise<{ userId: string }>; searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

export default async function AdminScoreDetailPage({ params, searchParams }: Props) {
  if (!(await currentAdmin())) notFound();
  const { userId } = await params;
  const sp = await searchParams;
  const error = first(sp.error);
  const done = first(sp.done);
  const detail = await loadUserScoreDetail(db(), userId);
  if (!detail) notFound();

  return (
    <section className="mx-auto px-[clamp(16px,4vw,56px)] pt-8 pb-20 sm:pt-12 max-w-4xl">
      <AdminNav current="/admin/scores" />
      <h1 className="display text-title">{detail.email ?? detail.telegramUsername ?? detail.userId}</h1>
      <Stats className="mt-4">
        <Stat label="Email" value={detail.email ?? "-"} />
        <Stat label="Telegram" value={detail.telegramUsername ?? "-"} />
        <Stat label="Identities" value={NUM.format(detail.identities.length)} />
        <Stat label="Joined" value={detail.createdAt ? DATE.format(fromSqlTime(detail.createdAt)) : "-"} />
      </Stats>

      {detail.identities.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-3 text-sm text-ink-muted">
          {detail.identities.map((i) => (
            <li key={`${i.kind}:${i.value}`}>
              {i.kind}: {i.value}
            </li>
          ))}
        </ul>
      ) : null}

      {error && error in ERRORS ? (
        <p role="alert" className="mt-6 rounded-lg border border-destructive/50 bg-surface px-4 py-3 text-sm text-ink">
          {ERRORS[error]}
        </p>
      ) : null}
      {done === "queued" ? (
        <p role="status" className="mt-6 rounded-lg border border-line bg-surface px-4 py-3 text-sm text-ink">
          Queued. The engine on the VPS will pick it up.
        </p>
      ) : null}

      <form action={rescoreNowAction} className="mt-6">
        <input type="hidden" name="user_id" value={detail.userId} />
        <Button type="submit" size="lg">
          Rescore now
        </Button>
      </form>

      <div className="mt-8 grid gap-6">
        {detail.roles.map((r) => (
          <RoleBlock key={r.role} view={r.view} />
        ))}
      </div>

      <details className="mt-8 text-sm">
        <summary className="cursor-pointer font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand">
          Raw source facts
        </summary>
        <div className="mt-3 grid gap-4">
          {detail.rawFacts.length === 0 ? (
            <p className="text-ink-muted">No source facts recorded yet.</p>
          ) : (
            detail.rawFacts.map((f) => (
              <div key={f.source} className="grid gap-1">
                <p className="font-semibold text-ink">
                  {f.source} <span className="font-normal text-ink-muted">- fetched {DATE.format(fromSqlTime(f.fetchedAt))}</span>
                </p>
                {f.gapReason ? <p className="text-ink-muted">Gap: {f.gapReason}</p> : null}
                <pre className="overflow-x-auto rounded-lg border border-line bg-surface p-3 text-xs whitespace-pre-wrap">
                  {f.factsJson ?? "null"}
                </pre>
              </div>
            ))
          )}
        </div>
      </details>
    </section>
  );
}
