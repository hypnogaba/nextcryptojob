import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ERROR, FIELD, HINT, LABEL } from "@/components/form/styles";
import { CARD, LINK, NoAccess, Notice, PageTitle } from "@/components/crm/ui";
import { Button } from "@/components/ui/button";
import { ROLES } from "@/lib/card/roles";
import { readAction, runAction } from "@/lib/crm/actions";
import { userFacingError } from "@/lib/crm/company";
import { CHAIN_TEXT, emptyReasonText, roleText } from "@/lib/crm/labels";
import { describeFilters, parseSearchParams, searchQuery } from "@/lib/crm/search-params";
import { CHAINS, type Account, type SearchResponse } from "@/lib/crm/types";
import { crmPage } from "../crm";
import { SaveSearchForm } from "./save-search-form";
import { SearchResults } from "./search-results";

export const metadata: Metadata = { title: "Search candidates", robots: { index: false } };

type Params = { [key: string]: string | string[] | undefined };

function one(params: Params, key: string): string {
  const v = params[key];
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

function Field({ id, label, error, children }: { id: string; label: string; error?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className={ERROR}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Check({ name, label, checked }: { name: string; label: string; checked: boolean }) {
  return (
    <label className="flex min-h-11 items-center gap-2 text-sm text-ink">
      <input type="checkbox" name={name} value="1" defaultChecked={checked} className="size-4 accent-brand" />
      {label}
    </label>
  );
}

/**
 * Пошук кандидатів (специфікація 5.2, 10.2 W2). Фільтри в адресі (GET), пошук
 * лише після "Search" (`q=1`), бо кожна сторінка витрачає денну квоту й пишеться
 * в журнал. Далі "Load more" додає сторінки, "Add to pipeline" з рядка,
 * "Save search" зберігає ті самі фільтри. Порожній результат називає причину.
 */
export default async function SearchPage({ searchParams }: { searchParams: Promise<Params> }) {
  const { ctx, company } = await crmPage("search");
  const params = await searchParams;
  const parsed = parseSearchParams(params);
  const canWrite = company.access === "subscription";
  const query = searchQuery(parsed.filters, parsed.sort, false);

  let result: SearchResponse | null = null;
  let error: string | null = null;
  if (company.access === "none") {
    // Сторінка нижче покаже, що доступу немає.
  } else if (company.access === "pay_per_request") {
    error = "Searching in the web app needs a subscription. Your agent can search through the API and pay with x402.";
  } else if (parsed.run) {
    try {
      result = (await runAction("search_candidates", { filters: parsed.filters, sort: parsed.sort }, ctx)).output as SearchResponse;
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

  const chains = new Set((Array.isArray(params.chains) ? params.chains : params.chains ? [params.chains] : []).map(String));
  const work = one(params, "work");
  const e = parsed.errors;

  const filtersForm = (
    <form
      id="filters"
      method="get"
      action="/company/search"
      aria-label="Search filters"
      className={`${CARD} grid content-start gap-4 p-4`}
      noValidate
    >
      <input type="hidden" name="q" value="1" />
      <Field id="role" label="Role" error={e.role}>
        <select id="role" name="role" defaultValue={one(params, "role")} className={FIELD}>
          <option value="">Any role</option>
          {Object.entries(ROLES).map(([key, r]) => (
            <option key={key} value={key}>
              {r.name}
            </option>
          ))}
        </select>
      </Field>
      <Field id="min_score" label="Min score" error={e.min_score}>
        <input id="min_score" name="min_score" type="number" inputMode="numeric" min={0} max={100} defaultValue={one(params, "min_score")} className={FIELD} />
      </Field>
      <fieldset className="grid gap-1.5">
        <legend className={LABEL}>Level</legend>
        <div className="flex items-center gap-2">
          <label htmlFor="min_level" className="sr-only">
            Min level
          </label>
          <input id="min_level" name="min_level" type="number" inputMode="numeric" min={1} max={10} placeholder="1" defaultValue={one(params, "min_level")} className={FIELD} />
          <span className="text-sm text-ink-muted">to</span>
          <label htmlFor="max_level" className="sr-only">
            Max level
          </label>
          <input id="max_level" name="max_level" type="number" inputMode="numeric" min={1} max={10} placeholder="10" defaultValue={one(params, "max_level")} className={FIELD} />
        </div>
        {e.min_level || e.max_level ? (
          <p role="alert" className={ERROR}>
            {e.min_level ?? e.max_level}
          </p>
        ) : null}
      </fieldset>
      <fieldset className="grid gap-0.5">
        <legend className={LABEL}>Chains (any of)</legend>
        <div className="grid grid-cols-2 gap-x-2">
          {CHAINS.map((c) => (
            <label key={c} className="flex min-h-11 items-center gap-2 text-sm text-ink">
              <input type="checkbox" name="chains" value={c} defaultChecked={chains.has(c)} className="size-4 accent-brand" />
              {CHAIN_TEXT[c]}
            </label>
          ))}
        </div>
      </fieldset>
      <Field id="years" label="Onchain" error={e.years}>
        <select id="years" name="years" defaultValue={one(params, "years")} className={FIELD}>
          <option value="">Any years</option>
          <option value="1">1+ year</option>
          <option value="2">2+ years</option>
          <option value="4">4+ years</option>
          <option value="6">6+ years</option>
        </select>
      </Field>
      <fieldset className="grid gap-0.5">
        <legend className={LABEL}>Work</legend>
        {[
          ["", "Any"],
          ["remote", "Remote"],
          ["city", "City"],
        ].map(([value, label]) => (
          <label key={value} className="flex min-h-11 items-center gap-2 text-sm text-ink">
            <input type="radio" name="work" value={value} defaultChecked={work === value} className="size-4 accent-brand" />
            {label}
          </label>
        ))}
        <label htmlFor="city" className="sr-only">
          City
        </label>
        <input
          id="city"
          name="city"
          type="text"
          maxLength={80}
          placeholder="City, when searching by city"
          defaultValue={one(params, "city")}
          aria-invalid={e.city ? true : undefined}
          aria-describedby={e.city ? "city-error" : undefined}
          className={FIELD}
        />
        {e.city ? (
          <p id="city-error" role="alert" className={ERROR}>
            {e.city}
          </p>
        ) : null}
      </fieldset>
      <div className="grid gap-0">
        <Check name="x_verified" label="X verified" checked={one(params, "x_verified") === "1"} />
        <Check name="wallet_verified" label="Wallet verified by signature" checked={one(params, "wallet_verified") === "1"} />
        <Check name="contact_direct" label="Telegram handle available" checked={one(params, "contact_direct") === "1"} />
        <Check name="hide_pipeline" label="Hide my pipeline" checked={one(params, "hide_pipeline") === "1"} />
      </div>
      <Field id="min_coverage" label="Min coverage, %" error={e.min_coverage}>
        <input id="min_coverage" name="min_coverage" type="number" inputMode="numeric" min={0} max={100} defaultValue={one(params, "min_coverage")} className={FIELD} />
      </Field>
      <Field id="sort" label="Sort">
        <select id="sort" name="sort" defaultValue={parsed.sort} className={FIELD}>
          <option value="score">Score</option>
          <option value="level">Level, then coverage</option>
          <option value="coverage">Coverage</option>
          <option value="newest">Newest</option>
        </select>
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" className="h-11 px-5 text-base">
          Search
        </Button>
        <Link href="/company/search" className={`${LINK} inline-flex min-h-11 items-center text-sm`}>
          Clear filters
        </Link>
      </div>
      <p className={HINT}>No filters by age, gender, origin, language or photo: we do not have such data.</p>
    </form>
  );

  const empty = result && result.data.length === 0 && result.empty_reason;

  return (
    <div className="mx-auto grid max-w-5xl gap-6 px-4 pt-8 pb-20 sm:px-6 sm:pt-12">
      <PageTitle
        aside={
          quota && quota.limit !== null && quota.remaining !== null
            ? `Searches left today: ${quota.remaining} of ${quota.limit}`
            : undefined
        }
      >
        Search candidates
      </PageTitle>
      {company.access === "none" ? (
        <NoAccess />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[18rem_1fr] lg:items-start">
          <div className={result ? "order-last lg:order-none" : undefined}>{filtersForm}</div>
          <section aria-labelledby="results-title" className="grid content-start gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="results-title" className="text-lg font-semibold tracking-tight">
                Results
              </h2>
              {result ? (
                <a href="#filters" className={`${LINK} text-sm lg:hidden`}>
                  Change filters
                </a>
              ) : null}
            </div>
            {error ? <Notice tone="error">{error}</Notice> : null}
            {!result && !error ? (
              <p className={HINT}>Choose filters and press Search. Each page of results counts toward your daily search limit.</p>
            ) : null}
            {result && empty ? (
              <Notice tone="info">
                <p>{emptyReasonText(empty, result.role_visible_count)}</p>
                {empty === "filters_too_narrow" ? (
                  <p className="mt-2">
                    <Link href={parsed.filters.role ? `/company/search?role=${parsed.filters.role}&q=1` : "/company/search"} className={LINK}>
                      Clear filters
                    </Link>
                  </p>
                ) : null}
              </Notice>
            ) : null}
            {result && !empty ? (
              <SearchResults
                key={query}
                companyId={company.id}
                query={query}
                initial={result}
                role={parsed.filters.role}
                canWrite={canWrite}
              />
            ) : null}
            {result && canWrite ? (
              <section aria-labelledby="save-title" className={`${CARD} grid gap-3 p-4`}>
                <h2 id="save-title" className="font-semibold tracking-tight">
                  Save this search
                </h2>
                <p className={HINT}>{describeFilters(parsed.filters, parsed.sort)}</p>
                <SaveSearchForm
                  companyId={company.id}
                  query={query}
                  suggestedName={parsed.filters.role ? `${roleText(parsed.filters.role)} search` : "My search"}
                />
              </section>
            ) : null}
          </section>
        </div>
      )}
    </div>
  );
}
