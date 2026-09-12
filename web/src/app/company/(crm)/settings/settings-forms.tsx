"use client";

import { useActionState, useState } from "react";
import { FormMessageLine } from "@/components/form/form-message";
import { ERROR, FIELD, HINT, LABEL, TEXTAREA } from "@/components/form/styles";
import { SubmitButton } from "@/components/form/submit-button";
import type { Country } from "@/lib/crm/countries";
import { closeCompanyAction, updateCompanySettingsAction, type CompanySettingsState } from "./actions";

type Profile = { name: string; website: string; country: string; about: string; x_handle: string };

function Err({ id, text }: { id: string; text?: string }) {
  return text ? (
    <p id={id} role="alert" className={ERROR}>
      {text}
    </p>
  ) : null;
}

export function CompanyProfileForm({ profile, countries, aboutMax }: { profile: Profile; countries: readonly Country[]; aboutMax: number }) {
  const [state, action] = useActionState(updateCompanySettingsAction, {} as CompanySettingsState);
  const e = state.errors ?? {};
  const v: Profile = { ...profile, ...(state.values ?? {}) };
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
          maxLength={80}
          autoComplete="organization"
          defaultValue={v.name}
          aria-invalid={e.name ? true : undefined}
          aria-describedby={e.name ? "name-error" : undefined}
          className={FIELD}
        />
        <Err id="name-error" text={e.name} />
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
          autoCapitalize="none"
          spellCheck={false}
          defaultValue={v.website}
          aria-invalid={e.website ? true : undefined}
          aria-describedby={e.website ? "website-error website-hint" : "website-hint"}
          className={FIELD}
        />
        <p id="website-hint" className={HINT}>
          A new domain is verified again with the email you signed in with.
        </p>
        <Err id="website-error" text={e.website} />
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="country" className={LABEL}>
          Country
        </label>
        <select
          id="country"
          name="country"
          defaultValue={v.country}
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
        <Err id="country-error" text={e.country} />
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="about" className={LABEL}>
          About
        </label>
        <textarea
          id="about"
          name="about"
          rows={3}
          maxLength={aboutMax}
          defaultValue={v.about}
          aria-invalid={e.about ? true : undefined}
          aria-describedby={e.about ? "about-error about-hint" : "about-hint"}
          className={TEXTAREA}
        />
        <p id="about-hint" className={HINT}>
          Candidates see this in your intro requests. Up to {aboutMax} characters.
        </p>
        <Err id="about-error" text={e.about} />
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="x_handle" className={LABEL}>
          X handle
        </label>
        <input
          id="x_handle"
          name="x_handle"
          type="text"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="@acme"
          defaultValue={v.x_handle}
          aria-invalid={e.x_handle ? true : undefined}
          aria-describedby={e.x_handle ? "x_handle-error" : undefined}
          className={FIELD}
        />
        <Err id="x_handle-error" text={e.x_handle} />
      </div>
      <div className="grid gap-2">
        <SubmitButton pendingLabel="Saving..." className="h-11 w-full px-5 text-base sm:w-fit">
          Save
        </SubmitButton>
        <FormMessageLine message={state.message} />
      </div>
    </form>
  );
}

export function CloseCompanyForm({ word }: { word: string }) {
  const [state, action] = useActionState(closeCompanyAction, {} as CompanySettingsState);
  const [typed, setTyped] = useState("");
  const error = state.errors?.confirm;
  return (
    <form action={action} className="grid gap-3">
      <p className={HINT}>
        Your subscription is canceled now, API keys stop working, pending intros are withdrawn. Data is deleted after 30
        days.
      </p>
      <div className="grid gap-1.5">
        <label htmlFor="confirm" className={LABEL}>
          Type {word} to confirm
        </label>
        <input
          id="confirm"
          name="confirm"
          type="text"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          value={typed}
          onChange={(ev) => setTyped(ev.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "confirm-error" : undefined}
          className={`${FIELD} sm:max-w-xs`}
        />
        <Err id="confirm-error" text={error} />
      </div>
      <div className="grid gap-2">
        <SubmitButton
          variant="destructive"
          pendingLabel="Closing..."
          disabled={typed.trim() !== word}
          className="h-11 w-full px-5 text-base sm:w-fit"
        >
          Close company
        </SubmitButton>
        <FormMessageLine message={state.message} />
      </div>
    </form>
  );
}
