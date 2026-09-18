import type { Metadata } from "next";
import Link from "next/link";
import { CARD, H2, H3, LINK, NoAccess, Notice, PAGE, PageTitle } from "@/components/crm/ui";
import { FIELD, HINT, LABEL } from "@/components/form/styles";
import { Button } from "@/components/ui/button";
import { readAction, runAction } from "@/lib/crm/actions";
import {
  BRIEF_MAX,
  briefFilters,
  briefFromParams,
  briefQuery,
  describeBrief,
  fitReasons,
  SHORTLIST_SIZE,
} from "@/lib/crm/brief";
import { userFacingError } from "@/lib/crm/company";
import { emptyReasonText, roleText } from "@/lib/crm/labels";
import { searchQuery } from "@/lib/crm/search-params";
import { signalItems, topSignals, type Signal } from "@/lib/crm/signals";
import type { Account, SearchResponse } from "@/lib/crm/types";
import { cn } from "@/lib/utils";
import { crmPage } from "../crm";
import { SearchResults } from "../search/search-results";
import { briefAction } from "./actions";

export const metadata: Metadata = { title: "Shortlist", robots: { index: false } };

type Params = { [key: string]: string | string[] | undefined };

const ERRORS: Record<string, string> = {
  empty: "Paste the job or write a few words about the role.",
  long: `Use up to ${BRIEF_MAX.toLocaleString("en-US")} characters.`,
  no_role: "We could not tell the role from this text. Put the job title on the first line, for example \"BD Lead\".",
};

/**
 * Шортлист за брифом (lib/crm/brief.ts). Без параметрів: поле для тексту вакансії. З роллю в
 * адресі: один пошук (одна сторінка з денної квоти) з фільтрами брифу, перші 10 за балом і рядок
 * «чому підходить» на кожного. Ролі-кнопки змінюють роль без нового тексту.
 */
export default async function ShortlistPage({ searchParams }: { searchParams: Promise<Params> }) {
  const { ctx, company } = await crmPage("shortlist");
  const params = await searchParams;
  const { brief, role } = briefFromParams(params);
  const errorKey = typeof params.error === "string" ? params.error : "";
  const jobId = typeof params.job === "string" ? params.job : undefined;

  let result: SearchResponse | null = null;
  let signals: Record<string, Signal[]> = {};
  let error: string | null = ERRORS[errorKey] ?? (errorKey ? "Something went wrong. Reload the page and try again." : null);
  if (company.access === "pay_per_request") {
    error = "Shortlists in the web app need a subscription. Your agent can search through the API and pay with x402.";
  } else if (company.access === "subscription" && role) {
    try {
      const out = (await runAction("search_candidates", { filters: briefFilters(brief, role), sort: "score", limit: SHORTLIST_SIZE }, ctx)).output as SearchResponse;
      result = { ...out, data: out.data.slice(0, SHORTLIST_SIZE), next_cursor: null, page_cap_reached: false };
      signals = await topSignals(ctx.db, signalItems(result));
    } catch (err) {
      const known = userFacingError(err);
      if (!known) throw err;
      error = known.message;
    }
  }

  let quota: Account["quotas"][string] | null = null;
  if (company.access === "subscription") {
    const account = (await readAction("get_account", {}, ctx)) as Account;
    quota = account.quotas.search_candidates ?? null;
  }

  const fit: Record<string, string[]> = {};
  if (result && role) for (const c of result.data) fit[c.candidate_id] = fitReasons(c, brief, role);
  const read = describeBrief(brief);
  const empty = result && result.data.length === 0 ? result.empty_reason : null;

  const form = (
    <form action={briefAction} className={`${CARD} grid gap-4 p-4 sm:p-5`} aria-labelledby="brief-title">
      <input type="hidden" name="company_id" value={company.id} />
      <h2 id="brief-title" className={H3}>
        {role ? "New brief" : "Your brief"}
      </h2>
      <div className="grid gap-1.5">
        <label htmlFor="brief" className={LABEL}>
          Paste the job, or describe the person you need
        </label>
        <textarea
          id="brief"
          name="brief"
          rows={role ? 4 : 9}
          maxLength={BRIEF_MAX}
          required
          placeholder={"Senior Rust Engineer\nWe build a perp DEX on Solana. Fully remote."}
          className={cn(FIELD, "h-auto py-2")}
        />
        <p className={HINT}>We read the role, remote or on site, and the chains from the text. We do not keep the text.</p>
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="city" className={LABEL}>
          Office city (leave empty for remote or any place)
        </label>
        <input id="city" name="city" type="text" maxLength={80} className={FIELD} />
      </div>
      <div>
        <Button type="submit" className="h-11 px-5 text-base">
          Find people
        </Button>
      </div>
      <p className={HINT}>Each shortlist is one search from your daily limit.</p>
    </form>
  );

  return (
    <div className={`${PAGE} max-w-5xl`}>
      <PageTitle
        aside={quota && quota.limit !== null && quota.remaining !== null ? `Searches left today: ${quota.remaining} of ${quota.limit}` : undefined}
      >
        Shortlist
      </PageTitle>
      {company.access === "none" ? (
        <NoAccess />
      ) : (
        <>
          {!role ? (
            <p className={cn(HINT, "max-w-2xl")}>
              Give us the job. We pick the {SHORTLIST_SIZE} best people for it by score and say why each one fits. You
              can also open a shortlist from any of your <Link href="/company/jobs" className={LINK}>jobs</Link>.
            </p>
          ) : null}
          {error ? <Notice tone="error">{error}</Notice> : null}
          {role ? (
            <section aria-labelledby="shortlist-title" className="grid gap-4">
              <div className="grid gap-2">
                <h2 id="shortlist-title" className={H2}>
                  Top {SHORTLIST_SIZE}: {roleText(role)}
                </h2>
                <p className="text-sm text-ink-muted" data-brief-read="">
                  {brief.confident ? "We read" : "Our best guess"}: {[roleText(role), ...read].join(", ")}. People already in
                  your pipeline are not shown.
                </p>
                {brief.roles.length > 1 || !brief.confident ? (
                  <nav aria-label="Other roles" className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-ink-muted">{brief.confident ? "Also fits:" : "Not right? Try:"}</span>
                    {brief.roles
                      .filter((r) => r !== role)
                      .map((r) => (
                        <Link
                          key={r}
                          href={`/company/shortlist?${briefQuery(brief, r, jobId)}`}
                          prefetch={false}
                          className="inline-flex min-h-11 items-center rounded-full border-2 border-line-strong bg-surface px-4 text-sm font-semibold text-ink hover:border-ink"
                        >
                          {roleText(r)}
                        </Link>
                      ))}
                  </nav>
                ) : null}
              </div>
              {empty ? (
                <Notice tone="info">
                  <p>{emptyReasonText(empty, result?.role_visible_count ?? null)}</p>
                  {brief.work ? (
                    <p className="mt-2">
                      <Link
                        href={`/company/shortlist?${briefQuery({ ...brief, work: null, city: null }, role, jobId)}`}
                        prefetch={false}
                        className={LINK}
                      >
                        Try again without the place filter
                      </Link>
                    </p>
                  ) : null}
                </Notice>
              ) : null}
              {result && !empty ? (
                <SearchResults
                  companyId={company.id}
                  query={searchQuery(briefFilters(brief, role))}
                  initial={result}
                  role={role}
                  canWrite
                  signals={signals}
                  fit={fit}
                />
              ) : null}
              {result && !empty ? (
                <p className="text-sm text-ink-muted">
                  Want more than {SHORTLIST_SIZE}?{" "}
                  <Link href={`/company/search?${searchQuery(briefFilters(brief, role))}`} prefetch={false} className={LINK}>
                    Open the full search
                  </Link>{" "}
                  with the same filters.
                </p>
              ) : null}
            </section>
          ) : null}
          {company.access === "subscription" ? form : null}
        </>
      )}
    </div>
  );
}

