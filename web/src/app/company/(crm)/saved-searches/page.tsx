import type { Metadata } from "next";
import Link from "next/link";
import { SubmitButton } from "@/components/form/submit-button";
import { SwitchButton } from "@/components/form/switch-button";
import { doneText, errorText, first } from "@/components/crm/messages";
import { CARD, EmptyState, LINK, NoAccess, Notice, PageTitle } from "@/components/crm/ui";
import { buttonVariants } from "@/components/ui/button";
import { readAction } from "@/lib/crm/actions";
import { savedSearchLimit, type SavedSearchList } from "@/lib/crm/saved-searches";
import { describeFilters, searchQuery } from "@/lib/crm/search-params";
import { cn } from "@/lib/utils";
import { crmPage } from "../crm";
import { deleteSavedSearchAction, toggleAlertAction } from "./actions";

export const metadata: Metadata = { title: "Saved searches", robots: { index: false } };

const TIME = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });

/**
 * Збережені пошуки (специфікація 5.7, 10.2): назва, короткий опис фільтрів,
 * перемикач "Daily alert", останнє сповіщення, "Run", "Delete". Спільні для
 * всієї команди. Сповіщення надсилає щогодинний cron (T11).
 */
export default async function SavedSearchesPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const { ctx, company } = await crmPage("saved-searches");
  const params = await searchParams;
  const done = doneText(first(params.done));
  const error = errorText(first(params.error));
  const canWrite = company.access === "subscription";

  if (company.access === "none") {
    return (
      <div className="mx-auto grid max-w-3xl gap-6 px-4 pt-8 pb-20 sm:px-6 sm:pt-12">
        <PageTitle>Saved searches</PageTitle>
        <NoAccess />
      </div>
    );
  }

  const { data } = (await readAction("list_saved_searches", {}, ctx)) as SavedSearchList;
  const limit = savedSearchLimit(company);

  return (
    <div className="mx-auto grid max-w-3xl gap-6 px-4 pt-8 pb-20 sm:px-6 sm:pt-12">
      <PageTitle aside={limit ? `${data.length} of ${limit}` : undefined}>Saved searches</PageTitle>
      {done ? <Notice tone="success">{done}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!canWrite ? <Notice tone="info">Read-only: no active subscription. Daily alerts are paused.</Notice> : null}

      {data.length === 0 ? (
        <EmptyState title="Save a search to get a daily email about new matches.">
          <Link href="/company/search" className={LINK}>
            Go to Search
          </Link>
        </EmptyState>
      ) : (
        <ul className="grid gap-3">
          {data.map((s) => {
            const labelId = `alert-${s.saved_search_id}`;
            return (
              <li key={s.saved_search_id} className={`${CARD} grid gap-3 p-4`}>
                <div className="grid gap-1">
                  <h2 className="font-semibold tracking-tight break-words">{s.name}</h2>
                  <p className="text-sm text-ink-muted">{describeFilters(s.filters, s.sort)}</p>
                  <p className="text-xs text-ink-muted">
                    {s.last_alert_at && s.last_match_count !== null
                      ? `Last alert ${TIME.format(new Date(s.last_alert_at))} UTC: ${s.last_match_count} new.`
                      : "No alert yet."}
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <form action={toggleAlertAction} className="flex items-center gap-2">
                    <input type="hidden" name="company_id" value={company.id} />
                    <input type="hidden" name="saved_search_id" value={s.saved_search_id} />
                    <input type="hidden" name="alert" value={s.alert === "daily" ? "off" : "daily"} />
                    <SwitchButton checked={s.alert === "daily"} labelledBy={labelId} disabled={!canWrite} />
                    <span id={labelId} className="text-sm text-ink">
                      Daily alert
                    </span>
                  </form>
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/company/search?${searchQuery(s.filters, s.sort)}`}
                      prefetch={false}
                      className={cn(buttonVariants({ variant: "outline" }), "h-11 px-4 text-sm")}
                    >
                      Run
                    </Link>
                    {canWrite ? (
                      <details className="relative">
                        <summary className="inline-flex h-11 cursor-pointer list-none items-center rounded-lg border border-border px-3 text-sm font-medium text-destructive hover:bg-muted [&::-webkit-details-marker]:hidden">
                          Delete
                        </summary>
                        <form action={deleteSavedSearchAction} className="absolute right-0 z-10 mt-1 grid w-64 gap-2 rounded-lg border border-line bg-surface p-3 shadow-lg">
                          <input type="hidden" name="company_id" value={company.id} />
                          <input type="hidden" name="saved_search_id" value={s.saved_search_id} />
                          <p className="text-sm text-ink">Delete &ldquo;{s.name}&rdquo; for the whole team?</p>
                          <SubmitButton variant="destructive" pendingLabel="Deleting..." className="h-11 px-3 text-sm">
                            Delete search
                          </SubmitButton>
                        </form>
                      </details>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
