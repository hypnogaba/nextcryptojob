"use client";

import { useActionState } from "react";
import { FormMessageLine } from "@/components/form/form-message";
import { FIELD, LABEL } from "@/components/form/styles";
import { SubmitButton } from "@/components/form/submit-button";
import { LINK_LABEL_MAX, LINK_URL_MAX } from "@/lib/card/profile-prefs";
import { addProofLinkAction, type LinkState } from "./proof-actions";

/** «Add link»: назва й адреса https. Показується лише з ключем і в PDF, на бал не впливає. */
export function ProofLinkForm() {
  const [state, action] = useActionState(addProofLinkAction, {} as LinkState);
  return (
    <form action={action} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-end">
      <label className="grid gap-1">
        <span className={LABEL}>Name</span>
        <input name="label" required maxLength={LINK_LABEL_MAX} defaultValue={state.label} placeholder="Hackathon win" className={FIELD} />
      </label>
      <label className="grid gap-1">
        <span className={LABEL}>Address</span>
        <input
          name="url"
          type="url"
          required
          maxLength={LINK_URL_MAX}
          defaultValue={state.url}
          placeholder="https://"
          className={FIELD}
        />
      </label>
      <SubmitButton pendingLabel="Adding..." variant="outline" className="h-11 px-4">
        Add link
      </SubmitButton>
      <div className="sm:col-span-3">
        <FormMessageLine message={state.message} />
      </div>
    </form>
  );
}
