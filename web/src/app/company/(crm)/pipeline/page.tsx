import type { Metadata } from "next";
import Link from "next/link";
import { FIELD, LABEL } from "@/components/form/styles";
import { doneText, errorText, first } from "@/components/crm/messages";
import { BOARD, POS, ScoreChip, TABLE, TD, TH, TR } from "@/components/board";
import { EmptyChip } from "@/components/crm/candidate-row";
import { Chip, EmptyState, LINK, NoAccess, Notice, PAGE, PageTitle, StageText } from "@/components/crm/ui";
import { POSITION_CODE } from "@/lib/roles/recipes";
import { Button } from "@/components/ui/button";
import { readAction } from "@/lib/crm/actions";
import { userFacingError } from "@/lib/crm/company";
import { expiresInText, roleScoreText, STAGE_ORDER, STAGE_TEXT } from "@/lib/crm/labels";
import type { PipelineList } from "@/lib/crm/pipeline";
import { HIDDEN_NOTICE, type Stage } from "@/lib/crm/types";
import { companyJobs } from "@/lib/crm/views";
import { isId } from "@/lib/ids";
import { crmPage } from "../crm";
import { settleDemoIntros } from "@/lib/admin/demo";
import { notifierFromEnv } from "@/lib/crm/notify";
import { BoardCard, MoveForm, WithdrawForm } from "./pipeline-card";
import { PipelineTabs } from "./pipeline-tabs";

export const metadata: Metadata = { title: "Pipeline", robots: { index: false } };

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const PER_STAGE = 50;

/**
 * Воронка (специфікація 5.4, 10.2 W4): шість колонок етапів; на вузькому екрані
 * колонки стають списком етапів, що розгортаються. Перенос через "Move to..."
 * (працює з клавіатури й без JS), "Withdraw" для знайомства, що чекає. Вигляд
 * "List": таблиця з прокруткою у власному контейнері. Фільтри: вакансія, тег.
 */
export default async function PipelinePage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const { ctx, company } = await crmPage("pipeline");
  // Демо-компанія: демо-кандидати «відповідають» самі за кілька секунд (lib/admin/demo.ts).
  if (company.isDemo) await settleDemoIntros(ctx.db, company.id, notifierFromEnv(ctx.env), ctx.now);
  const params = await searchParams;
  const view = first(params.view) === "list" ? "list" : "board";
  const jobParam = first(params.job);
  const job = isId("job", jobParam) ? jobParam : undefined;
  const tag = first(params.tag)?.trim().slice(0, 32) || undefined;
  const cursor = first(params.cursor);
  const done = doneText(first(params.done));
  const error = errorText(first(params.error));
  const canWrite = company.access === "subscription";

  if (company.access === "none") {
    return (
      <div className={`${PAGE} max-w-5xl`}>
        <PageTitle>Pipeline</PageTitle>
        <NoAccess />
      </div>
    );
  }

  const filters = { ...(job ? { job_id: job } : {}), ...(tag ? { tag } : {}) };
  const back = { companyId: company.id, view: view === "list" ? "list" : undefined, job, tag };
  const filterQuery = new URLSearchParams({ ...(job ? { job } : {}), ...(tag ? { tag } : {}) }).toString();
  const jobs = await companyJobs(ctx);

  let columns: { stage: Stage; list: PipelineList }[] = [];
  let list: PipelineList | null = null;
  let counts: Record<string, number> = {};
  let listError: string | null = null;
  try {
    if (view === "board") {
      columns = await Promise.all(
        STAGE_ORDER.map(async (stage) => ({
          stage,
          list: (await readAction("list_pipeline", { stage, ...filters, limit: PER_STAGE }, ctx)) as PipelineList,
        })),
      );
      counts = columns[0]?.list.counts ?? {};
    } else {
      list = (await readAction("list_pipeline", { ...filters, ...(cursor ? { cursor } : {}), limit: PER_STAGE }, ctx)) as PipelineList;
      counts = list.counts;
    }
  } catch (err) {
    const known = userFacingError(err);
    if (!known) throw err;
    listError = known.message;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const filtered = Boolean(job || tag);

  return (
    <div className={`${PAGE} max-w-5xl`}>
      <PageTitle aside={total ? `${total} ${total === 1 ? "candidate" : "candidates"}` : undefined}>Pipeline</PageTitle>
      {done ? <Notice tone="success">{done}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {listError ? <Notice tone="error">{listError}</Notice> : null}
      {!canWrite ? <Notice tone="info">Read-only: no active subscription.</Notice> : null}

      <div className="grid gap-4">
        <PipelineTabs current={view} query={filterQuery} />
        <form method="get" action="/company/pipeline" aria-label="Pipeline filters" className="flex flex-wrap items-end gap-2">
          {view === "list" ? <input type="hidden" name="view" value="list" /> : null}
          <div className="grid gap-1">
            <label htmlFor="filter-job" className={LABEL}>
              Job
            </label>
            <select id="filter-job" name="job" defaultValue={job ?? ""} className={`${FIELD} w-44`}>
              <option value="">All jobs</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.title}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1">
            <label htmlFor="filter-tag" className={LABEL}>
              Tag
            </label>
            <input id="filter-tag" name="tag" type="text" maxLength={32} placeholder="Any" defaultValue={tag ?? ""} className={`${FIELD} w-36`} />
          </div>
          <Button type="submit" variant="outline" className="h-11 px-4 text-sm">
            Filter
          </Button>
          {filtered ? (
            <Link href={view === "list" ? "/company/pipeline?view=list" : "/company/pipeline"} className={`${LINK} inline-flex min-h-11 items-center text-sm`}>
              Clear
            </Link>
          ) : null}
        </form>
      </div>

      {total === 0 && !listError ? (
        <EmptyState title="Your pipeline is empty. Find candidates in Search and add them here.">
          <Link href="/company/search" className={LINK}>
            Go to Search
          </Link>
        </EmptyState>
      ) : view === "board" ? (
        <div className="grid grid-cols-1 gap-x-3 gap-y-5 md:grid-cols-3 xl:grid-cols-6 xl:items-start">
          {columns.map(({ stage, list: col }) => {
            const n = filtered ? col.data.length : (counts[stage] ?? 0);
            return (
              <details key={stage} open={n > 0} className="group min-w-0">
                <summary className="flex min-h-11 cursor-pointer list-none items-end justify-between gap-2 border-b-2 border-ink pb-1.5 [&::-webkit-details-marker]:hidden">
                  <span className={`display text-base leading-tight ${stage === "contact_shared" ? "text-brand" : ""}`}>
                    {STAGE_TEXT[stage]} ({n}
                    {filtered && col.next_cursor ? "+" : ""})
                  </span>
                  <span aria-hidden className="pb-0.5 text-xs text-ink-muted transition-transform group-open:rotate-180">
                    &#9662;
                  </span>
                </summary>
                <div className="mt-3 grid gap-2">
                  {col.data.length ? (
                    col.data.map((card) => <BoardCard key={card.candidate_id} card={card} back={back} canWrite={canWrite} now={ctx.now} />)
                  ) : (
                    <p className="rounded-lg border border-dashed border-line-strong px-3 py-4 text-sm text-ink-muted">No candidates here.</p>
                  )}
                  {col.next_cursor ? (
                    <Link href={`/company/pipeline?view=list${filterQuery ? `&${filterQuery}` : ""}`} className={`${LINK} text-sm`}>
                      See all in the list
                    </Link>
                  ) : null}
                </div>
              </details>
            );
          })}
        </div>
      ) : list ? (
        <div className="grid min-w-0 gap-3">
          <div className={BOARD}>
            <table className={`${TABLE} min-w-[56rem]`}>
              <caption className="sr-only">Pipeline cards, newest activity first</caption>
              <thead>
                <tr>
                  <th scope="col" className={TH}>
                    Card
                  </th>
                  <th scope="col" className={TH}>
                    Candidate
                  </th>
                  <th scope="col" className={TH}>
                    Pos
                  </th>
                  <th scope="col" className={TH}>
                    Stage
                  </th>
                  <th scope="col" className={TH}>
                    Tags
                  </th>
                  <th scope="col" className={TH}>
                    Intro or contact
                  </th>
                  <th scope="col" className={TH}>
                    Updated
                  </th>
                  <th scope="col" className={TH}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((card) => {
                  const h = card.visibility === "hidden" ? null : card.headline;
                  return (
                    <tr key={card.candidate_id} className={TR}>
                      <td className={TD}>
                        {h?.score != null ? <ScoreChip score={h.score} level={h.level} /> : <EmptyChip />}
                      </td>
                      <th scope="row" className={`${TD} min-w-44 font-normal`}>
                        <Link
                          href={`/company/candidates/${card.candidate_id}`}
                          prefetch={false}
                          className="font-mono font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand"
                        >
                          {card.label}
                        </Link>
                        <span className="mt-1 block text-ink-muted">
                          {card.visibility === "hidden" ? HIDDEN_NOTICE : h ? roleScoreText(h) : null}
                        </span>
                      </th>
                      <td className={TD}>{h ? <span className={POS}>{POSITION_CODE[h.role]}</span> : null}</td>
                      <td className={TD}>
                        <StageText stage={card.stage} declinedBy={card.declined_by} />
                      </td>
                      <td className={TD}>
                        <span className="flex flex-wrap gap-1">
                          {card.tags.map((t) => (
                            <Chip key={t}>{t}</Chip>
                          ))}
                        </span>
                      </td>
                      <td className={`${TD} text-ink`}>
                        {card.contact ? (
                          <span className="font-mono break-all">{card.contact.value}</span>
                        ) : card.open_intro ? (
                          <span className="text-ink-muted">{expiresInText(card.open_intro.expires_at, ctx.now)}</span>
                        ) : null}
                      </td>
                      <td className={`${TD} whitespace-nowrap text-ink-muted`}>
                        <time dateTime={card.updated_at}>{DATE.format(new Date(card.updated_at))}</time>
                      </td>
                      <td className={`${TD} w-56`}>
                        <div className="grid gap-2">
                          <MoveForm card={card} back={back} canWrite={canWrite} />
                          <WithdrawForm card={card} back={back} canWrite={canWrite} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {list.data.length === 0 ? <p className="p-4 text-sm text-ink-muted">No cards match these filters.</p> : null}
          </div>
          <div className="flex flex-wrap gap-3">
            {cursor ? (
              <Link href={`/company/pipeline?view=list${filterQuery ? `&${filterQuery}` : ""}`} className={`${LINK} inline-flex min-h-11 items-center text-sm`}>
                First page
              </Link>
            ) : null}
            {list.next_cursor ? (
              <Link
                href={`/company/pipeline?${new URLSearchParams({ view: "list", ...(job ? { job } : {}), ...(tag ? { tag } : {}), cursor: list.next_cursor }).toString()}`}
                className={`${LINK} inline-flex min-h-11 items-center text-sm`}
              >
                Next page
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
