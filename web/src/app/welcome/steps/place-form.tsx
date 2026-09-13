"use client";

import { useActionState, useState } from "react";
import { FormMessageLine } from "@/components/form/form-message";
import { ERROR, FIELD, HINT, LABEL } from "@/components/form/styles";
import { SubmitButton } from "@/components/form/submit-button";
import { CURRENCIES, type WhereChoice } from "@/lib/onboarding/place";
import { cn } from "@/lib/utils";
import { savePlaceAction } from "../actions/answers";
import type { StepState } from "../flow";

const CHOICES: { value: WhereChoice; label: string; hint: string }[] = [
  { value: "remote", label: "Remote", hint: "From anywhere" },
  { value: "city", label: "In a city", hint: "On site in one city" },
  { value: "both", label: "Both", hint: "Remote or in my city" },
];

export type PlaceInitial = { where: WhereChoice | null; city: string; salary: string; currency: string };

export function PlaceForm({ initial }: { initial: PlaceInitial }) {
  const [state, action] = useActionState(savePlaceAction, {} as StepState);
  const [where, setWhere] = useState<WhereChoice | null>(initial.where);
  const v = state.values;
  const needsCity = where === "city" || where === "both";

  return (
    <form action={action} className="grid gap-6">
      <fieldset className="grid gap-2">
        <legend className="sr-only">Where</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {CHOICES.map((c) => (
            <label
              key={c.value}
              className={cn(
                "flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border bg-surface px-3 py-3 transition-colors",
                where === c.value ? "border-ink shadow-[inset_0_0_0_1px_var(--ink)]" : "border-line hover:border-line-strong",
              )}
            >
              <input
                type="radio"
                name="where"
                value={c.value}
                checked={where === c.value}
                onChange={() => setWhere(c.value)}
                className="mt-0.5 size-5 shrink-0 accent-[var(--brand)]"
              />
              <span className="grid gap-0.5">
                <span className="text-sm font-medium text-ink">{c.label}</span>
                <span className="text-xs text-ink-muted">{c.hint}</span>
              </span>
            </label>
          ))}
        </div>
        {state.errors?.where ? (
          <p role="alert" className={ERROR}>
            {state.errors.where}
          </p>
        ) : null}
      </fieldset>

      {needsCity ? (
        <div className="grid gap-2">
          <label htmlFor="city" className={LABEL}>
            City
          </label>
          <input
            id="city"
            name="city"
            type="text"
            autoComplete="address-level2"
            required
            defaultValue={v?.city ?? initial.city}
            placeholder="Lisbon"
            aria-invalid={state.errors?.city ? true : undefined}
            className={FIELD}
          />
          <p className={HINT}>We only show jobs in this exact city.</p>
          {state.errors?.city ? (
            <p role="alert" className={ERROR}>
              {state.errors.city}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-2">
        <label htmlFor="salary" className={LABEL}>
          Lowest yearly salary you would take <span className="font-normal text-ink-muted">(optional)</span>
        </label>
        <div className="flex gap-2">
          <input
            id="salary"
            name="salary"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            defaultValue={v?.salary ?? initial.salary}
            placeholder="90000"
            aria-invalid={state.errors?.salary ? true : undefined}
            className={cn(FIELD, "min-w-0 flex-1")}
          />
          <label htmlFor="currency" className="sr-only">
            Currency
          </label>
          <select
            id="currency"
            name="currency"
            defaultValue={v?.currency ?? initial.currency}
            className={cn(FIELD, "w-24 shrink-0")}
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        {state.errors?.salary ? (
          <p role="alert" className={ERROR}>
            {state.errors.salary}
          </p>
        ) : null}
      </div>

      <FormMessageLine message={state.message} />
      <SubmitButton pendingLabel="Saving..." className="h-11 text-base" disabled={!where}>
        Continue
      </SubmitButton>
    </form>
  );
}
