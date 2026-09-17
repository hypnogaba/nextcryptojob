import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminNav } from "@/components/admin-nav";
import { BucketTabs, VisitsChart } from "@/components/admin-chart";
import { NUM, pct, Panel } from "@/components/admin-ui";
import { BOARD, TABLE, TD_TIGHT, TH_TIGHT, TR } from "@/components/board";
import { currentAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { FUNNEL_WINDOWS, loadFunnelReport, type FunnelWindow } from "@/lib/admin/funnel";
import { isVisitBucket, loadVisitSeries, type VisitBucket } from "@/lib/analytics/visits";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Funnel", robots: { index: false } };

function parseWindow(raw: string | undefined): FunnelWindow {
  const n = Number(raw);
  return (FUNNEL_WINDOWS as readonly number[]).includes(n) ? (n as FunnelWindow) : 7;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AdminFunnelPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  if (!(await currentAdmin())) notFound();
  const params = await searchParams;
  const window = parseWindow(first(params.window));
  const rawStep = first(params.step);
  const bucket: VisitBucket = isVisitBucket(rawStep) ? rawStep : "day";
  const [report, series] = await Promise.all([loadFunnelReport(db(), window), loadVisitSeries(db(), bucket)]);

  return (
    <section className="mx-auto px-[clamp(16px,4vw,56px)] pt-8 pb-20 sm:pt-12 max-w-4xl">
      <AdminNav current="/admin/funnel" />
      <h1 className="display text-title">Funnel</h1>
      <p className="mt-2 text-sm text-ink-muted">
        Visitors down to applying to a job, over the last {window} day{window === 1 ? "" : "s"}.
      </p>

      <nav aria-label="Window" className="mt-4 flex gap-3 text-sm">
        {FUNNEL_WINDOWS.map((w) => (
          <Link
            key={w}
            href={`/admin/funnel?window=${w}`}
            aria-current={w === window ? "page" : undefined}
            className={cn(
              "inline-flex min-h-11 items-center border-b-2 px-1 font-semibold",
              w === window ? "border-ink text-ink" : "border-transparent text-ink-muted hover:border-line-strong hover:text-ink",
            )}
          >
            {w} day{w === 1 ? "" : "s"}
          </Link>
        ))}
      </nav>

      {!report.visitsAvailable ? <p className="mt-4 text-sm text-ink-muted">{report.visitsError}</p> : null}

      <Panel id="visitors-chart" title="Visitors" className="mt-6">
        <BucketTabs base="/admin/funnel" current={bucket} extra={{ window: String(window) }} />
        <VisitsChart series={series} />
      </Panel>

      <Panel id="steps" title="Steps" className="mt-6">
        <div className={BOARD}>
          <table className={TABLE}>
            <thead>
              <tr>
                <th className={TH_TIGHT}>Step</th>
                <th className={`${TH_TIGHT} text-right`}>Count</th>
                <th className={`${TH_TIGHT} text-right`}>From previous step</th>
              </tr>
            </thead>
            <tbody>
              {report.steps.map((s) => (
                <tr key={s.key} className={TR}>
                  <td className={TD_TIGHT}>{s.label}</td>
                  <td className={`${TD_TIGHT} text-right tabular-nums`}>{NUM.format(s.count)}</td>
                  <td className={`${TD_TIGHT} text-right tabular-nums`}>{s.fromPrev === null ? "-" : pct(Math.round(s.fromPrev * 100), 100)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-ink-muted">
          Digest active is a snapshot of right now, not counted within the window. Visitors, card views and share clicks are anonymous daily
          counters, not the same people tracked step by step; treat conversions as rough, not exact.
        </p>
      </Panel>
    </section>
  );
}
