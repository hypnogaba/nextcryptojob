import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AdminNav } from "@/components/admin-nav";
import { Ago, NUM, Panel, pct, Stat, Stats, SubHead } from "@/components/admin-ui";
import { BOARD, TABLE, TD_TIGHT, TH_TIGHT, TR } from "@/components/board";
import {
  cachedDemandReport,
  DEMAND_LIVE_DAYS,
  loadDemandReport,
  type Count,
  type DemandReport,
} from "@/lib/admin/demand";
import { currentAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { jobsDb } from "@/lib/jobs-db";
import { fromSqlTime } from "@/lib/time";

export const metadata: Metadata = { title: "Jobs and demand", robots: { index: false } };

/**
 * /admin/demand: що люди шукають і що в нас є (власник 17.09). Два списки поруч, без
 * зведення в один відсоток: роль людини і сфера вакансії це різні мірки.
 */

const TD = TD_TIGHT;
const TD_NUM = `${TD} text-right tabular-nums`;
const TH_NUM = `${TH_TIGHT} text-right`;

function Bars({ rows, total, empty }: { rows: Count[]; total: number; empty: string }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  if (rows.length === 0) return <p className="text-sm text-ink-muted">{empty}</p>;
  return (
    <div className={BOARD}>
      <table className={TABLE}>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={TR} data-row={r.key}>
              <th scope="row" className={`${TD} font-normal`}>{r.label}</th>
              <td className={`${TD} w-1/2`}>
                <span aria-hidden className="block h-2.5 rounded-sm bg-brand/25" style={{ width: `${Math.max(3, (r.n / max) * 100)}%` }} />
              </td>
              <td className={TD_NUM}>{NUM.format(r.n)}</td>
              <td className={`${TD_NUM} text-ink-muted`}>{total > 0 ? pct(r.n, total) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function People({ report, now }: { report: DemandReport; now: number }) {
  const p = report.people;
  return (
    <Panel id="people" title="What people look for" links={[{ href: "/admin/candidates", label: "Candidates" }]}>
      <Stats className="sm:grid-cols-3">
        <Stat label="People" value={NUM.format(p.total)} note={`${NUM.format(p.withBrief)} said what they want`} />
        <Stat
          label="Remote only"
          value={NUM.format(p.places.find((x) => x.key === "remote")?.n ?? 0)}
          note={`${NUM.format(p.places.find((x) => x.key === "not said")?.n ?? 0)} have not said yet`}
        />
        <Stat
          label="Pay asked"
          value={p.pay.length > 0 ? `${NUM.format(p.pay[0]!.median)} ${p.pay[0]!.currency}` : "-"}
          note={p.pay.length > 0 ? `Median of ${NUM.format(p.pay[0]!.people)} people, a year` : "Nobody named a number yet"}
        />
      </Stats>

      <div className="grid gap-2">
        <SubHead>Roles they picked</SubHead>
        <Bars rows={p.roles} total={p.withBrief} empty="Nobody has finished the brief yet." />
      </div>

      <div className="grid gap-2">
        <SubHead>Where they want to work</SubHead>
        <Bars rows={p.places} total={p.total} empty="Nothing yet." />
        {p.cities.length > 0 ? (
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm" data-list="cities">
            {p.cities.map((c) => (
              <span key={c.key} className="whitespace-nowrap">
                {c.label}: <b>{NUM.format(c.n)}</b>
              </span>
            ))}
          </p>
        ) : null}
      </div>

      <div className="grid gap-2">
        <SubHead>In their own words</SubHead>
        {p.words.length === 0 ? (
          <p className="text-sm text-ink-muted">Nobody has written their own words yet.</p>
        ) : (
          <ul className="grid gap-2 text-sm" data-list="words">
            {p.words.map((w, i) => (
              <li key={i} className="grid gap-0.5 border-l-2 border-line pl-3">
                <span className="break-words text-ink">{w.text}</span>
                <span className="text-xs text-ink-muted">
                  {w.kind === "target" ? "What I am looking for" : "My role is not in the list"}
                  {w.at ? (
                    <>
                      , <Ago at={fromSqlTime(w.at).getTime()} now={now} />
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-ink-muted">
          Their own sentences from the brief. Good for the words we use on the site and in the X posts, and for roles
          the list is missing.
        </p>
      </div>
    </Panel>
  );
}

function Jobs({ report }: { report: DemandReport }) {
  const j = report.jobs;
  return (
    <Panel id="jobs" title="What we have" links={[{ href: "/admin/sources", label: "Job sources" }]}>
      {!j.available ? (
        <p role="alert" className="text-sm text-ink">
          Could not read the job database: {j.error}
        </p>
      ) : null}
      <Stats className="sm:grid-cols-4">
        <Stat label="Live jobs" value={NUM.format(j.live)} note={`Seen by a scan in ${DEMAND_LIVE_DAYS} days`} />
        <Stat label="Remote" value={NUM.format(j.remote)} note={j.live > 0 ? `${pct(j.remote, j.live)} of live jobs` : undefined} />
        <Stat label="With a salary" value={NUM.format(j.withSalary)} note={j.live > 0 ? `${pct(j.withSalary, j.live)} of live jobs` : undefined} />
        <Stat label="Employers" value={NUM.format(j.companies)} />
      </Stats>

      <div className="grid gap-2">
        <SubHead>By field</SubHead>
        <Bars rows={j.spheres} total={j.live} empty="No live jobs." />
        <p className="text-xs text-ink-muted">
          The field comes from the job title when the scan reads it, so a job with no clear field is only tagged web3
          and is not in this list.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="grid gap-2">
          <SubHead>Where the jobs are</SubHead>
          {j.locations.length === 0 ? (
            <p className="text-sm text-ink-muted">No locations given.</p>
          ) : (
            <div className={BOARD}>
              <table className={TABLE} data-table="locations">
                <thead>
                  <tr>
                    <th scope="col" className={TH_TIGHT}>Location</th>
                    <th scope="col" className={TH_NUM}>Live jobs</th>
                  </tr>
                </thead>
                <tbody>
                  {j.locations.map((l) => (
                    <tr key={l.key} className={TR}>
                      <th scope="row" className={`${TD} font-normal`}>{l.label}</th>
                      <td className={TD_NUM}>{NUM.format(l.n)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="grid gap-2">
          <SubHead>Who is hiring most</SubHead>
          {j.topCompanies.length === 0 ? (
            <p className="text-sm text-ink-muted">No employers yet.</p>
          ) : (
            <div className={BOARD}>
              <table className={TABLE} data-table="employers">
                <thead>
                  <tr>
                    <th scope="col" className={TH_TIGHT}>Employer</th>
                    <th scope="col" className={TH_NUM}>Live jobs</th>
                  </tr>
                </thead>
                <tbody>
                  {j.topCompanies.map((c) => (
                    <tr key={c.key} className={TR}>
                      <th scope="row" className={`${TD} font-normal`}>{c.label}</th>
                      <td className={TD_NUM}>{NUM.format(c.n)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}

export default async function AdminDemandPage() {
  if (!(await currentAdmin())) notFound();
  const main = db();
  const now = new Date().getTime();
  const report = await cachedDemandReport((at) => loadDemandReport(main, jobsDb(), at));

  return (
    <section className="mx-auto max-w-6xl px-[clamp(16px,4vw,56px)] pt-8 pb-20 sm:pt-12">
      <AdminNav current="/admin/demand" />
      <h1 className="display text-title">Jobs and demand</h1>
      <p className="mt-2 max-w-prose text-sm text-ink-muted">
        What people ask for, and what the job database holds. Two lists side by side, not one number: a person picks a
        role out of 15, while a scanned job only gets a broad field from its title, so a difference between the two
        columns is not a gap we measured.
      </p>

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-2">
        <People report={report} now={now} />
        <Jobs report={report} />
      </div>

      <p className="mt-8 text-xs text-ink-muted" data-cost="">
        Counted <Ago at={report.computedAt} now={now} /> and kept for 10 minutes: each count reads every live job.
      </p>
    </section>
  );
}
