import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminNav } from "@/components/admin-nav";
import { LINK, NUM, Panel } from "@/components/admin-ui";
import { BOARD, TABLE, TD_TIGHT, TH_TIGHT, TR } from "@/components/board";
import { FIELD } from "@/components/form/styles";
import { Button } from "@/components/ui/button";
import { loadScoreDistribution, searchScoreUsers } from "@/lib/admin/scores";
import { currentAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Scores", robots: { index: false } };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Мала гістограма рівнів 1-10: 10 стовпчиків, найвищий = 100%. */

export default async function AdminScoresPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  if (!(await currentAdmin())) notFound();
  const params = await searchParams;
  const q = first(params.q) ?? "";
  const [dist, hits] = await Promise.all([loadScoreDistribution(db()), q ? searchScoreUsers(db(), q) : Promise.resolve([])]);

  return (
    <section className="mx-auto px-[clamp(16px,4vw,56px)] pt-8 pb-20 sm:pt-12 max-w-6xl">
      <AdminNav current="/admin/scores" />
      <h1 className="display text-title">Scores</h1>
      <p className="mt-2 text-sm text-ink-muted">
        Weights and points come from the same formula code as the candidate&apos;s own score page (
        <code>lib/score/explain.ts</code>). Nothing here is a hand-written number.
      </p>

      <form action="/admin/scores" method="get" className="mt-6 flex max-w-md flex-wrap items-end gap-3">
        <label className="grid flex-1 gap-1 text-sm">
          <span className="font-semibold text-ink-muted">Search by X handle or email</span>
          <input type="text" name="q" defaultValue={q} placeholder="ada or ada@example.com" className={FIELD} />
        </label>
        <Button type="submit" className="h-11">
          Search
        </Button>
      </form>
      {q ? (
        <div className="mt-3">
          {hits.length === 0 ? (
            <p className="text-sm text-ink-muted">No match for &quot;{q}&quot;.</p>
          ) : (
            <ul className="grid gap-1 text-sm">
              {hits.map((h) => (
                <li key={h.userId}>
                  <Link
                    href={`/admin/scores/${h.userId}`}
                    className="font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand"
                  >
                    {h.email ?? h.xHandle ?? h.userId}
                  </Link>
                  {h.xHandle ? <span className="text-ink-muted"> - @{h.xHandle}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <p className="mt-8 text-sm text-ink-muted" data-moved="quality">
        The quality gate and the score spread per role moved out: whether the formula passed is on{" "}
        <Link href="/admin/health" className={LINK}>Health</Link>, and what people ask for is on{" "}
        <Link href="/admin/demand" className={LINK}>Jobs and demand</Link>.
      </p>

      <Panel id="gaps" title="Gaps per source" className="mt-6">
        {dist.sourceGaps.length === 0 ? (
          <p className="text-sm text-ink-muted">No source facts recorded yet.</p>
        ) : (
          <div className={BOARD}>
            <table className={TABLE}>
              <thead>
                <tr>
                  <th className={TH_TIGHT}>Source</th>
                  <th className={`${TH_TIGHT} text-right`}>Total</th>
                  <th className={`${TH_TIGHT} text-right`}>With a gap</th>
                </tr>
              </thead>
              <tbody>
                {dist.sourceGaps.map((g) => (
                  <tr key={g.source} className={TR}>
                    <td className={TD_TIGHT}>{g.source}</td>
                    <td className={`${TD_TIGHT} text-right tabular-nums`}>{NUM.format(g.total)}</td>
                    <td className={`${TD_TIGHT} text-right tabular-nums`}>{NUM.format(g.gaps)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel id="suspicious" title="Suspicious" className="mt-6">
        <p className="mb-2 text-sm text-ink-muted">Level 8+ with cover under 50%, or score 0 / missing while identities exist.</p>
        {dist.suspicious.length === 0 ? (
          <p className="text-sm text-ink-muted">Nothing flagged.</p>
        ) : (
          <div className={BOARD}>
            <table className={TABLE}>
              <thead>
                <tr>
                  <th className={TH_TIGHT}>Person</th>
                  <th className={TH_TIGHT}>Role</th>
                  <th className={`${TH_TIGHT} text-right`}>Score</th>
                  <th className={`${TH_TIGHT} text-right`}>Level</th>
                  <th className={`${TH_TIGHT} text-right`}>Cover</th>
                  <th className={TH_TIGHT}>Why</th>
                </tr>
              </thead>
              <tbody>
                {dist.suspicious.map((s) => (
                  <tr key={`${s.userId}:${s.role}`} className={TR}>
                    <td className={TD_TIGHT}>
                      <Link href={`/admin/scores/${s.userId}`} className="font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand">
                        {s.email ?? s.userId}
                      </Link>
                    </td>
                    <td className={TD_TIGHT}>{s.roleName}</td>
                    <td className={`${TD_TIGHT} text-right tabular-nums`}>{s.score ?? "-"}</td>
                    <td className={`${TD_TIGHT} text-right tabular-nums`}>{s.level ?? "-"}</td>
                    <td className={`${TD_TIGHT} text-right tabular-nums`}>{s.cover ?? "-"}</td>
                    <td className={TD_TIGHT}>{s.reason === "low_cover" ? "Low cover for a high level" : "No score with identities connected"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </section>
  );
}
