"use client";

import Link from "next/link";
import { useActionState } from "react";
import { FormMessageLine } from "@/components/form/form-message";
import { ERROR, FIELD, HINT, LABEL } from "@/components/form/styles";
import { SubmitButton } from "@/components/form/submit-button";
import type { Country } from "@/lib/crm/countries";
import { registerCompanyAction, type StartState } from "./actions";

// Вибраний варіант як у налаштуваннях кандидата: рамка кольору тексту подвійної товщини.
const RADIO_ROW =
  "flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface p-3 transition-colors hover:border-line-strong " +
  "has-[:checked]:border-ink has-[:checked]:shadow-[inset_0_0_0_1px_var(--ink)]";

function FieldError({ id, text }: { id: string; text?: string }) {
  return text ? (
    <p id={id} role="alert" className={ERROR}>
      {text}
    </p>
  ) : null;
}

export function StartForm({ countries, agency }: { countries: readonly Country[]; agency: boolean }) {
  const [state, action] = useActionState(registerCompanyAction, {} as StartState);
  const e = state.errors ?? {};
  const v = state.values ?? {};
  const hiringFor = v.hiring_for || (agency ? "agency" : "own_team");
  return (
    <form action={action} className="grid gap-5" noValidate>
      <div className="grid gap-1.5">
        <label htmlFor="name" className={LABEL}>
          Company name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          maxLength={80}
          autoComplete="organization"
          defaultValue={v.name}
          aria-invalid={e.name ? true : undefined}
          aria-describedby={e.name ? "name-error" : undefined}
          className={FIELD}
        />
        <FieldError id="name-error" text={e.name} />
      </div>

      <div className="grid gap-1.5">
        <label htmlFor="website" className={LABEL}>
          Website
        </label>
        <input
          id="website"
          name="website"
          type="text"
          inputMode="url"
          required
          placeholder="acme.io"
          autoComplete="url"
          autoCapitalize="none"
          spellCheck={false}
          defaultValue={v.website}
          aria-invalid={e.website ? true : undefined}
          aria-describedby={e.website ? "website-error website-hint" : "website-hint"}
          className={FIELD}
        />
        <p id="website-hint" className={HINT}>
          If your email is on this domain, candidates see it as verified.
        </p>
        <FieldError id="website-error" text={e.website} />
      </div>

      <div className="grid gap-1.5">
        <label htmlFor="country" className={LABEL}>
          Country
        </label>
        <select
          id="country"
          name="country"
          required
          defaultValue={v.country ?? ""}
          aria-invalid={e.country ? true : undefined}
          aria-describedby={e.country ? "country-error" : undefined}
          className={FIELD}
        >
          <option value="" disabled>
            Choose a country
          </option>
          {countries.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </select>
        <FieldError id="country-error" text={e.country} />
      </div>

      <fieldset className="grid gap-2" aria-describedby={e.hiring_for ? "hiring-error" : undefined}>
        <legend className={`${LABEL} mb-2`}>Who are you hiring for?</legend>
        <label className={RADIO_ROW}>
          <input
            type="radio"
            name="hiring_for"
            value="own_team"
            defaultChecked={hiringFor === "own_team"}
            className="mt-1 size-5 shrink-0 accent-[var(--brand)]"
          />
          <span className="grid gap-0.5">
            <span className="text-base font-semibold text-ink">Our own team</span>
            <span className={HINT}>You get access right away. Choose how to pay on the next step.</span>
          </span>
        </label>
        <label className={RADIO_ROW}>
          <input
            type="radio"
            name="hiring_for"
            value="agency"
            defaultChecked={hiringFor === "agency"}
            className="mt-1 size-5 shrink-0 accent-[var(--brand)]"
          />
          <span className="grid gap-0.5">
            <span className="text-base font-semibold text-ink">Our clients (recruiting agency)</span>
            <span className={HINT}>Tell us about your agency next. We review applications within 2 business days.</span>
          </span>
        </label>
        <FieldError id="hiring-error" text={e.hiring_for} />
      </fieldset>

      <div className="grid gap-1.5">
        <label className="flex min-h-11 cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            name="terms"
            required
            aria-invalid={e.terms ? true : undefined}
            aria-describedby={e.terms ? "terms-error" : undefined}
            className="mt-1 size-5 shrink-0 accent-[var(--brand)]"
          />
          <span className="text-base text-ink">
            I agree to the{" "}
            <Link href="/terms/companies" target="_blank" className="font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand">
              Company Terms
            </Link>
            : hiring only, no resale, no bulk export.
          </span>
        </label>
        <FieldError id="terms-error" text={e.terms} />
      </div>

      <div className="grid gap-2">
        <SubmitButton pendingLabel="Creating..." className="h-11 w-full px-5 text-base sm:w-fit">
          Create company
        </SubmitButton>
        <FormMessageLine message={state.message} />
      </div>
    </form>
  );
}
