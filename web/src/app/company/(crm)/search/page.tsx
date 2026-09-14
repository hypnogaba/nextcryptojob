import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ERROR, FIELD, HINT, LABEL } from "@/components/form/styles";
import { CARD, H2, H3, LINK, NoAccess, Notice, PAGE, PageTitle } from "@/components/crm/ui";
import { Button } from "@/components/ui/button";
import { ROLES } from "@/lib/card/roles";
import { readAction, runAction } from "@/lib/crm/actions";
import { userFacingError } from "@/lib/crm/company";
import { CHAIN_TEXT, emptyReasonText, roleText } from "@/lib/crm/labels";
import { describeFilters, parseSearchParams, searchQuery } from "@/lib/crm/search-params";
import { signalItems, topSignals, type Signal } from "@/lib/crm/signals";
import { SCORED_ROLE_KEYS } from "@/lib/roles/recipes";
import { cn } from "@/lib/utils";
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
      <input type="checkbox" name={name} value="1" defaultChecked={checked} className="size-5 shrink-0 accent-brand" />
      {label}
    </label>
  );
}

/**
 * «I'm hiring»: роль одним натисканням. Посилання одразу запускає пошук за цією роллю,
 * найвищий бал першим (q=1, sort за замовчуванням score), тобто рівно один пошук з денної
 * квоти на вибір ролі. Без попереднього завантаження: prefetch витратив би квоту за кожну
 * роль, повз яку пройшла миша.
 */
function RolePicker({ active }: { active: string | undefined }) {
  return (
    <nav aria-label="I'm hiring" className="grid gap-2" data-role-picker="">
      <p className="font-display text-[1.25rem] leading-none font-extrabold tracking-[0.02em] uppercase">I&apos;m hiring</p>
      <ul className="flex flex-wrap gap-2">
        {SCORED_ROLE_KEYS.map((key) => {
          const on = key === active;
          return (
            <li key={key}>
              <Link
                href={`/company/search?role=${key}&q=1`}
                prefetch={false}
                aria-current={on ? "true" : undefined}
                className={cn(
                  "inline-flex min-h-11 items-center rounded-full border-2 px-4 text-sm font-semibold transition-colors",
                  on ? "border-ink bg-ink text-surface" : "border-line-strong bg-surface text-ink hover:border-ink",
                )}
              >
                {ROLES[key].name}
              </Link>
            </li>
          );
        })}
      </ul>
      <p className={HINT}>Pick a role: we show who fits it best, highest score first. Each pick is one search from your daily limit.</p>
    </nav>
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
  let signals: Record<string, Signal[]> = {};
  let error: string | null = null;
  if (company.access === "none") {
    // Сторінка нижче покаже, що доступу немає.
  } else if (company.access === "pay_per_request") {
    error = "Searching in the web app needs a subscription. Your agent can search through the API and pay with x402.";
  } else if (parsed.run) {
    try {
      result = (await runAction("search_candidates", { filters: parsed.filters, sort: parsed.sort }, ctx)).output as SearchResponse;
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

  const chains = new Set((Array.isArray(params.chains) ? params.chains : params.chains ? [params.chains] : []).map(String));
  const work = one(params, "work");
  const e = parsed.errors;

  const filtersForm = (
    <form
      // Новий вибір ролі вгорі (перехід без перезавантаження) має показати свої значення у фільтрах.
      key={query}
      id="filters"
      method="get"
      action="/company/search"
      aria-label="Search filters"
      className={`${CARD} grid content-start gap-4 p-4`}
      noValidate
    >
      <input type="hidden" name="q" value="1" />
      <h2 className={H3}>Filters</h2>
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
              <input type="checkbox" name="chains" value={c} defaultChecked={chains.has(c)} className="size-5 shrink-0 accent-brand" />
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
            <input type="radio" name="work" value={value} defaultChecked={work === value} className="size-5 shrink-0 accent-brand" />
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
        <Check name="contact_direct" label="Telegram handle directly" checked={one(params, "contact_direct") === "1"} />
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
    <div className={`${PAGE} max-w-5xl`}>
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
        <>
        {company.access === "subscription" ? <RolePicker active={parsed.run ? parsed.filters.role : undefined} /> : null}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[18rem_minmax(0,1fr)] lg:items-start">
          <div className={result ? "order-last lg:order-none" : undefined}>{filtersForm}</div>
          <section aria-labelledby="results-title" className="grid content-start gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="results-title" className={H2}>
                {result && parsed.filters.role ? `Best matches: ${roleText(parsed.filters.role)}` : "Results"}
              </h2>
              {result ? (
                <a href="#filters" className={`${LINK} text-sm lg:hidden`}>
                  Change filters
                </a>
              ) : null}
            </div>
            {error ? <Notice tone="error">{error}</Notice> : null}
            {!result && !error ? (
              <p className={HINT}>
                Pick a role above, or choose filters and press Search. Each page of results counts toward your daily search limit.
              </p>
            ) : null}
            {result && !empty ? (
              <p className={HINT} data-contact-rule="">
                The chip shows the score and its level. Candidates marked &ldquo;Telegram handle directly&rdquo; share their
                Telegram: press Show Telegram and message them directly. For the others, request an intro: the candidate
                decides, and if they accept you get their Telegram.
              </p>
            ) : null}
            {result && empty ? (
              <Notice tone="info">
                <p>{emptyReasonText(empty, result.role_visible_count)}</p>
                {empty === "filters_too_narrow" ? (
                  <p className="mt-2">
                    <Link
                      href={parsed.filters.role ? `/company/search?role=${parsed.filters.role}&q=1` : "/company/search"}
                      prefetch={false}
                      className={LINK}
                    >
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
                signals={signals}
              />
            ) : null}
            {result && canWrite ? (
              <section aria-labelledby="save-title" className={`${CARD} grid gap-3 p-4 sm:p-5`}>
                <h2 id="save-title" className={H3}>
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
        </>
      )}
    </div>
  );
}
