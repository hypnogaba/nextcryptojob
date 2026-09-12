"use client";

import { useActionState } from "react";
import { FormMessageLine } from "@/components/form/form-message";
import { ERROR, FIELD, HINT, LABEL, TEXTAREA } from "@/components/form/styles";
import { SubmitButton } from "@/components/form/submit-button";
import type { Country } from "@/lib/crm/countries";
import { submitApplicationAction, type ApplyState } from "./actions";

type Defaults = {
  contact_name: string;
  contact_email: string;
  website: string;
  country: string;
  clients_text: string;
  volume_text: string;
  data_use_text: string;
};

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className={HINT}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} role="alert" className={ERROR}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function describedBy(id: string, error?: string, hint?: boolean): string | undefined {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean);
  return ids.length ? ids.join(" ") : undefined;
}

export function ApplyForm({ defaults, countries, resubmit }: { defaults: Defaults; countries: readonly Country[]; resubmit: boolean }) {
  const [state, action] = useActionState(submitApplicationAction, {} as ApplyState);
  const e = state.errors ?? {};
  const v = { ...defaults, ...(state.values ?? {}) };
  return (
    <form action={action} className="grid gap-5" noValidate>
      <Field id="contact_name" label="Contact name" error={e.contact_name}>
        <input
          id="contact_name"
          name="contact_name"
          type="text"
          autoComplete="name"
          maxLength={80}
          defaultValue={v.contact_name}
          aria-invalid={e.contact_name ? true : undefined}
          aria-describedby={describedBy("contact_name", e.contact_name)}
          className={FIELD}
        />
      </Field>
      <Field id="contact_email" label="Work email" error={e.contact_email}>
        <input
          id="contact_email"
          name="contact_email"
          type="email"
          autoComplete="email"
          defaultValue={v.contact_email}
          aria-invalid={e.contact_email ? true : undefined}
          aria-describedby={describedBy("contact_email", e.contact_email)}
          className={FIELD}
        />
      </Field>
      <Field id="website" label="Website" error={e.website}>
        <input
          id="website"
          name="website"
          type="text"
          inputMode="url"
          autoCapitalize="none"
          spellCheck={false}
          defaultValue={v.website}
          aria-invalid={e.website ? true : undefined}
          aria-describedby={describedBy("website", e.website)}
          className={FIELD}
        />
      </Field>
      <Field id="country" label="Country" error={e.country}>
        <select
          id="country"
          name="country"
          defaultValue={v.country}
          aria-invalid={e.country ? true : undefined}
          aria-describedby={describedBy("country", e.country)}
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
      </Field>
      <Field id="clients_text" label="Who do you recruit for?" hint="Kinds of clients, stages, regions. Names only if you can share them." error={e.clients_text}>
        <textarea
          id="clients_text"
          name="clients_text"
          rows={3}
          maxLength={1000}
          defaultValue={v.clients_text}
          aria-invalid={e.clients_text ? true : undefined}
          aria-describedby={describedBy("clients_text", e.clients_text, true)}
          className={TEXTAREA}
        />
      </Field>
      <Field id="volume_text" label="How many hires per quarter?" error={e.volume_text}>
        <input
          id="volume_text"
          name="volume_text"
          type="text"
          maxLength={200}
          placeholder="For example, 3 to 5"
          defaultValue={v.volume_text}
          aria-invalid={e.volume_text ? true : undefined}
          aria-describedby={describedBy("volume_text", e.volume_text)}
          className={FIELD}
        />
      </Field>
      <Field id="data_use_text" label="How will you use candidate profiles?" error={e.data_use_text}>
        <textarea
          id="data_use_text"
          name="data_use_text"
          rows={3}
          maxLength={1000}
          defaultValue={v.data_use_text}
          aria-invalid={e.data_use_text ? true : undefined}
          aria-describedby={describedBy("data_use_text", e.data_use_text)}
          className={TEXTAREA}
        />
      </Field>
      <div className="grid gap-1.5">
        <label className="flex min-h-11 cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            name="no_resale_ack"
            aria-invalid={e.no_resale_ack ? true : undefined}
            aria-describedby={e.no_resale_ack ? "no_resale_ack-error" : undefined}
            className="mt-1 size-5 shrink-0 accent-[var(--brand)]"
          />
          <span className="text-base text-ink">We will not resell or share candidate data outside a hiring process.</span>
        </label>
        {e.no_resale_ack ? (
          <p id="no_resale_ack-error" role="alert" className={ERROR}>
            {e.no_resale_ack}
          </p>
        ) : null}
      </div>
      <div className="grid gap-2">
        <SubmitButton pendingLabel="Sending..." className="h-11 w-full px-5 text-base sm:w-fit">
          {resubmit ? "Send the updated application" : "Send application"}
        </SubmitButton>
        <FormMessageLine message={state.message} />
      </div>
    </form>
  );
}
