import type { Metadata } from "next";
import Link from "next/link";
import { SubmitButton } from "@/components/form/submit-button";
import { doneText, errorText, first } from "@/components/crm/messages";
import { CARD, EmptyState, LINK, NoAccess, Notice, PageTitle } from "@/components/crm/ui";
import { readAction } from "@/lib/crm/actions";
import { userFacingError } from "@/lib/crm/company";
import { expiresInText, INTRO_STATUS_TEXT, roleText } from "@/lib/crm/labels";
import { companyIntroNotice } from "@/lib/crm/notify";
import { candidateLabel } from "@/lib/crm/project";
import type { Intro, IntroStatus } from "@/lib/crm/types";
import { cn } from "@/lib/utils";
import { crmPage } from "../../crm";
import { withdrawIntroAction } from "../actions";
import { PipelineTabs } from "../pipeline-tabs";

export const metadata: Metadata = { title: "Intros", robots: { index: false } };

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

const FILTERS: { key: IntroStatus | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "pending", label: "Waiting" },
  { key: "accepted", label: "Accepted" },
  { key: "declined", label: "Declined" },
  { key: "expired", label: "Expired" },
  { key: "canceled", label: "Withdrawn" },
];

/**
 * Знайомства компанії (специфікація 5.5, 10.2): стан кожного запиту, скільки
 * лишилось до прострочення, контакт після «так», "We could not reach the
 * candidate yet." коли сповіщення не дійшло (T5), "Withdraw" для тих, що чекають.
 */
export default async function IntrosPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const { ctx, company } = await crmPage("pipeline");
  const params = await searchParams;
  const statusParam = first(params.status);
  const status = FILTERS.some((f) => f.key === statusParam && f.key !== "all") ? (statusParam as IntroStatus) : undefined;
  const cursor = first(params.cursor);
  const done = doneText(first(params.done));
  const error = errorText(first(params.error));
  const canWrite = company.access === "subscription";

  if (company.access === "none") {
    return (
      <div className="mx-auto grid max-w-4xl gap-6 px-4 pt-8 pb-20 sm:px-6 sm:pt-12">
        <PageTitle>Intros</PageTitle>
        <NoAccess />
      </div>
    );
  }

  let intros: { data: Intro[]; next_cursor: string | null } = { data: [], next_cursor: null };
  let listError: string | null = null;
  try {
    intros = (await readAction("list_intros", { ...(status ? { status } : {}), ...(cursor ? { cursor } : {}), limit: 50 }, ctx)) as typeof intros;
  } catch (err) {
    const known = userFacingError(err);
    if (!known) throw err;
    listError = known.message;
  }

  return (
    <div className="mx-auto grid max-w-4xl gap-6 px-4 pt-8 pb-20 sm:px-6 sm:pt-12">
      <PageTitle>Intros</PageTitle>
      {done ? <Notice tone="success">{done}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {listError ? <Notice tone="error">{listError}</Notice> : null}
      <PipelineTabs current="intros" />
      <nav aria-label="Intro status" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <ul className="flex min-w-max gap-1">
          {FILTERS.map((f) => {
            const current = (f.key === "all" && !status) || f.key === status;
            return (
              <li key={f.key}>
                <Link
                  href={f.key === "all" ? "/company/pipeline/intros" : `/company/pipeline/intros?status=${f.key}`}
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "inline-flex min-h-11 items-center rounded-md px-3 text-sm font-medium",
                    current ? "bg-brand-soft text-ink" : "text-ink-muted hover:bg-wash hover:text-ink",
                  )}
                >
                  {f.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {intros.data.length === 0 && !listError ? (
        <EmptyState title={status ? "No intros with this status." : "No intros yet."}>
          Open a candidate from{" "}
          <Link href="/company/search" className={LINK}>
            Search
          </Link>{" "}
          and press Request intro.
        </EmptyState>
      ) : (
        <ol className="grid gap-3">
          {intros.data.map((i) => {
            const notice = companyIntroNotice(i);
            return (
              <li key={i.intro_id} className={`${CARD} grid gap-2 p-4`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <Link href={`/company/candidates/${i.candidate_id}`} prefetch={false} className="font-mono font-semibold text-ink underline-offset-4 hover:underline">
                    {candidateLabel(i.candidate_id)}
                  </Link>
                  <span className="text-sm font-medium text-ink">{INTRO_STATUS_TEXT[i.status] ?? i.status}</span>
                </div>
                <p className="text-sm text-ink-muted">
                  {i.role ? `${roleText(i.role)} role. ` : ""}Requested on {DATE.format(new Date(i.created_at))}
                  {i.requested_via !== "web" ? ` through the ${i.requested_via === "mcp" ? "MCP server" : "API"}` : ""}.
                  {i.status === "pending" ? ` ${expiresInText(i.expires_at, ctx.now)}.` : ""}
                  {i.responded_at && i.status !== "pending" ? ` Answered on ${DATE.format(new Date(i.responded_at))}.` : ""}
                </p>
                <p className="line-clamp-3 text-sm break-words text-ink">&ldquo;{i.message}&rdquo;</p>
                {i.contact ? (
                  <p className="text-sm text-ink">
                    {i.contact.kind === "telegram" ? "Telegram" : "Email"}: <span className="font-mono break-all">{i.contact.value}</span>
                  </p>
                ) : null}
                {notice ? <Notice tone="warning">{notice}</Notice> : null}
                {i.status === "pending" && canWrite ? (
                  <form action={withdrawIntroAction}>
                    <input type="hidden" name="company_id" value={company.id} />
                    <input type="hidden" name="from" value="intros" />
                    {status ? <input type="hidden" name="status" value={status} /> : null}
                    <input type="hidden" name="intro_id" value={i.intro_id} />
                    <SubmitButton pendingLabel="Withdrawing..." variant="outline" className="h-11 px-4 text-sm">
                      Withdraw request
                    </SubmitButton>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
      <div className="flex flex-wrap gap-3">
        {cursor ? (
          <Link href={status ? `/company/pipeline/intros?status=${status}` : "/company/pipeline/intros"} className={`${LINK} inline-flex min-h-11 items-center text-sm`}>
            First page
          </Link>
        ) : null}
        {intros.next_cursor ? (
          <Link
            href={`/company/pipeline/intros?${new URLSearchParams({ ...(status ? { status } : {}), cursor: intros.next_cursor }).toString()}`}
            className={`${LINK} inline-flex min-h-11 items-center text-sm`}
          >
            Next page
          </Link>
        ) : null}
      </div>
    </div>
  );
}
