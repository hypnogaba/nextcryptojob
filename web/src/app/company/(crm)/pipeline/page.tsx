import type { Metadata } from "next";
import Link from "next/link";
import { FIELD, LABEL } from "@/components/form/styles";
import { doneText, errorText, first } from "@/components/crm/messages";
import { CARD, Chip, EmptyState, LINK, NoAccess, Notice, PageTitle, StageChip } from "@/components/crm/ui";
import { Button } from "@/components/ui/button";
import { readAction } from "@/lib/crm/actions";
import { userFacingError } from "@/lib/crm/company";
import { expiresInText, roleScoreText, STAGE_ORDER, STAGE_TEXT } from "@/lib/crm/labels";
import type { PipelineList } from "@/lib/crm/pipeline";
import { HIDDEN_NOTICE, type Stage } from "@/lib/crm/types";
import { companyJobs } from "@/lib/crm/views";
import { isId } from "@/lib/ids";
import { crmPage } from "../crm";
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
      <div className="mx-auto grid max-w-6xl gap-6 px-4 pt-8 pb-20 sm:px-6 sm:pt-12">
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
    <div className="mx-auto grid max-w-7xl gap-6 px-4 pt-8 pb-20 sm:px-6 sm:pt-12">
      <PageTitle aside={total ? `${total} ${total === 1 ? "candidate" : "candidates"}` : undefined}>Pipeline</PageTitle>
      {done ? <Notice tone="success">{done}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {listError ? <Notice tone="error">{listError}</Notice> : null}
      {!canWrite ? <Notice tone="info">Read-only: no active subscription.</Notice> : null}

      <div className="flex flex-wrap items-end justify-between gap-3">
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
        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6 xl:items-start">
          {columns.map(({ stage, list: col }) => {
            const n = filtered ? col.data.length : (counts[stage] ?? 0);
            return (
              <details key={stage} open={n > 0} className={`${CARD} group p-3`}>
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 font-semibold tracking-tight [&::-webkit-details-marker]:hidden">
                  <span>
                    {STAGE_TEXT[stage]} ({n}
                    {filtered && col.next_cursor ? "+" : ""})
                  </span>
                  <span aria-hidden className="text-sm text-ink-muted transition-transform group-open:rotate-180">
                    &#9662;
                  </span>
                </summary>
                <div className="mt-2 grid gap-2">
                  {col.data.length ? (
                    col.data.map((card) => <BoardCard key={card.candidate_id} card={card} back={back} canWrite={canWrite} now={ctx.now} />)
                  ) : (
                    <p className="text-sm text-ink-muted">No candidates here.</p>
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
        <div className="grid gap-3">
          <div className={`${CARD} overflow-x-auto`}>
            <table className="w-full min-w-[48rem] text-sm">
              <caption className="sr-only">Pipeline cards, newest activity first</caption>
              <thead>
                <tr className="border-b border-line text-left text-ink-muted">
                  <th scope="col" className="px-3 py-2 font-medium">
                    Candidate
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Stage
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Score
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Tags
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Intro or contact
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Updated
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((card) => (
                  <tr key={card.candidate_id} className="border-b border-line align-top last:border-b-0">
                    <th scope="row" className="px-3 py-2 text-left font-normal">
                      <Link href={`/company/candidates/${card.candidate_id}`} prefetch={false} className="font-mono font-semibold text-ink underline-offset-4 hover:underline">
                        {card.label}
                      </Link>
                    </th>
                    <td className="px-3 py-2">
                      <StageChip stage={card.stage} declinedBy={card.declined_by} />
                    </td>
                    <td className="px-3 py-2 text-ink">
                      {card.visibility === "hidden" ? <span className="text-ink-muted">{HIDDEN_NOTICE}</span> : card.headline ? roleScoreText(card.headline) : null}
                    </td>
                    <td className="px-3 py-2">
                      <span className="flex flex-wrap gap-1">
                        {card.tags.map((t) => (
                          <Chip key={t}>{t}</Chip>
                        ))}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-ink">
                      {card.contact ? (
                        <span className="font-mono break-all">{card.contact.value}</span>
                      ) : card.open_intro ? (
                        <span className="text-ink-muted">{expiresInText(card.open_intro.expires_at, ctx.now)}</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-ink-muted">
                      <time dateTime={card.updated_at}>{DATE.format(new Date(card.updated_at))}</time>
                    </td>
                    <td className="grid w-60 gap-2 px-3 py-2">
                      <MoveForm card={card} back={back} canWrite={canWrite} />
                      <WithdrawForm card={card} back={back} canWrite={canWrite} />
                    </td>
                  </tr>
                ))}
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
