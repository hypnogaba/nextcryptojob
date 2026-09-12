"use client";

import { useActionState } from "react";
import { FormMessageLine } from "@/components/form/form-message";
import { ERROR, FIELD, LABEL } from "@/components/form/styles";
import { SubmitButton } from "@/components/form/submit-button";
import { claimXAction } from "../actions/x";
import type { StepState } from "../flow";

export function ClaimXForm() {
  const [state, action] = useActionState(claimXAction, {} as StepState);
  const error = state.errors?.handle;
  return (
    <form action={action} className="grid gap-3">
      <label htmlFor="handle" className={LABEL}>
        X handle
      </label>
      <div className="relative">
        <span aria-hidden className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-ink-muted">
          @
        </span>
        <input
          id="handle"
          name="handle"
          type="text"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          required
          defaultValue={state.values?.handle ?? ""}
          placeholder="yourhandle"
          aria-invalid={error ? true : undefined}
          aria-describedby="handle-error"
          className={`${FIELD} pl-8`}
        />
      </div>
      {error ? (
        <p id="handle-error" role="alert" className={ERROR}>
          {error}
        </p>
      ) : null}
      <FormMessageLine message={state.message} />
      <SubmitButton pendingLabel="Saving..." className="h-11 text-base">
        Get my code
      </SubmitButton>
    </form>
  );
}
