"use client";

import { useActionState } from "react";
import { FormMessageLine } from "@/components/form/form-message";
import { ERROR, FIELD, LABEL } from "@/components/form/styles";
import { SubmitButton } from "@/components/form/submit-button";
import { saveSearchAction, type SaveSearchState } from "./actions";

/** "Save search" (W2): назва й щоденне сповіщення про нових кандидатів. */
export function SaveSearchForm({ companyId, query, suggestedName }: { companyId: string; query: string; suggestedName: string }) {
  const [state, action] = useActionState(saveSearchAction, {} as SaveSearchState);
  return (
    <form action={action} className="grid gap-3" noValidate>
      <input type="hidden" name="company_id" value={companyId} />
      <input type="hidden" name="query" value={query} />
      <div className="grid gap-1.5">
        <label htmlFor="saved-name" className={LABEL}>
          Name
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="saved-name"
            name="name"
            type="text"
            maxLength={80}
            required
            defaultValue={state.error ? state.name : suggestedName}
            aria-invalid={state.error ? true : undefined}
            aria-describedby={state.error ? "saved-name-error" : undefined}
            className={FIELD}
          />
          <SubmitButton pendingLabel="Saving..." className="h-11 shrink-0 px-5 text-base">
            Save search
          </SubmitButton>
        </div>
        {state.error ? (
          <p id="saved-name-error" role="alert" className={ERROR}>
            {state.error}
          </p>
        ) : null}
      </div>
      <label className="flex min-h-11 items-center gap-2 text-sm text-ink">
        <input type="checkbox" name="alert" value="off" className="size-5 shrink-0 accent-brand" />
        No daily email for this search
      </label>
      <FormMessageLine message={state.message} />
    </form>
  );
}
