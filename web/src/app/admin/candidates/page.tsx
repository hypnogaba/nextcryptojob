import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminNav } from "@/components/admin-nav";
import { BOARD, TABLE, TD_TIGHT, TH_TIGHT, TR } from "@/components/board";
import { FIELD } from "@/components/form/styles";
import { Button } from "@/components/ui/button";
import { Panel, pct, NUM, Stat, Stats, SubHead } from "@/components/admin-ui";
import { listCandidates } from "@/lib/admin/scores";
import { loadOverview, type Overview } from "@/lib/admin/overview";
import { currentAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { fromSqlTime } from "@/lib/time";

export const metadata: Metadata = { title: "Candidates", robots: { index: false } };

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

const TD = TD_TIGHT;
const TD_NUM = `${TD} text-right tabular-nums`;
const TH_NUM = `${TH_TIGHT} text-right`;

function Candidates({ o }: { o: Overview }) {
  const c = o.candidates;
  const funnel: [string, number][] = [
    ["Signed up", c.total],
    ["Brief started", c.briefStarted],
    ["Brief done, terms accepted", c.briefDone],
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


function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * /admin/candidates (п.17, 15.09: власник не знайшов розбір балу людини з адмінки): люди, найновіші
 * перші, кожен рядок веде на /admin/scores/<id> (там повний розбір балу). Пошук зверху, як на
 * /admin/scores: email, Telegram чи X-нік.
 */
export default async function AdminCandidatesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  if (!(await currentAdmin())) notFound();
  const params = await searchParams;
  const q = first(params.q) ?? "";
  const [rows, overview] = await Promise.all([listCandidates(db(), { q, limit: 200 }), loadOverview(db())]);

  return (
    <section className="mx-auto px-[clamp(16px,4vw,56px)] pt-8 pb-20 sm:pt-12 max-w-5xl">
      <AdminNav current="/admin/candidates" />
      <h1 className="display text-title">Candidates</h1>
      <p className="mt-2 text-sm text-ink-muted">
        Every person, newest first. Open a row for the full score breakdown (same page as the candidate&apos;s own score page).
      </p>

      <form action="/admin/candidates" method="get" className="mt-6 flex max-w-md flex-wrap items-end gap-3">
        <label className="grid flex-1 gap-1 text-sm">
          <span className="font-semibold text-ink-muted">Search by email, Telegram or X handle</span>
          <input type="text" name="q" defaultValue={q} placeholder="ada or ada@example.com" className={FIELD} />
        </label>
        <Button type="submit" className="h-11">
          Search
        </Button>
      </form>

      <div className="mt-8">
        <Candidates o={overview} />
      </div>

      {rows.length === 0 ? (
        <p className="mt-8 text-sm text-ink-muted">{q ? `No match for "${q}".` : "No candidates yet."}</p>
      ) : (
        <div className={`mt-8 ${BOARD}`}>
          <table className={TABLE}>
            <thead>
              <tr>
                <th className={TH_TIGHT}>Person</th>
                <th className={TH_TIGHT}>Signed up</th>
                <th className={`${TH_TIGHT} text-right`}>Best score</th>
                <th className={`${TH_TIGHT} text-right`}>Level</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.userId} className={TR}>
                  <td className={TD_TIGHT}>
                    <Link
                      href={`/admin/scores/${r.userId}`}
                      className="font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand"
                    >
                      {r.email ?? (r.xHandle ? `@${r.xHandle}` : r.telegramUsername ?? r.userId)}
                    </Link>
                    {r.xHandle && r.email ? <span className="text-ink-muted"> - @{r.xHandle}</span> : null}
                  </td>
                  <td className={TD_TIGHT}>{r.createdAt ? DATE.format(fromSqlTime(r.createdAt)) : "-"}</td>
                  <td className={`${TD_TIGHT} text-right tabular-nums`}>{r.bestScore ?? "-"}</td>
                  <td className={`${TD_TIGHT} text-right tabular-nums`}>{r.bestLevel ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
