"use client";

import { useActionState } from "react";
import { FormMessageLine } from "@/components/form/form-message";
import { ERROR, FIELD, HINT, LABEL } from "@/components/form/styles";
import { SubmitButton } from "@/components/form/submit-button";
import { saveXAction } from "../actions/x";
import type { StepState } from "../flow";

/** Нік X: обов'язкове поле, «@handle» чи посилання x.com/handle; зберігаємо без «@» у нижньому регістрі. */
export function XForm({ initial, editing }: { initial: string; editing: boolean }) {
  const [state, action] = useActionState(saveXAction, {} as StepState);
  const error = state.errors?.handle;
  return (
    <form action={action} className="grid gap-3">
      <label htmlFor="handle" className={LABEL}>
        Your X handle
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
          defaultValue={state.values?.handle ?? initial}
          placeholder="yourhandle"
          aria-invalid={error ? true : undefined}
          aria-describedby="handle-hint handle-error"
          className={`${FIELD} pl-8`}
        />
      </div>
      <p id="handle-hint" className={HINT}>
        Your handle or a link like x.com/yourhandle. No code and no sign-in with X: we take your word for it.
      </p>
      {error ? (
        <p id="handle-error" role="alert" className={ERROR}>
          {error}
        </p>
      ) : null}
      <FormMessageLine message={state.message} />
      <SubmitButton pendingLabel="Saving..." className="h-11 text-base">
        {editing ? "Save" : "Save and continue"}
      </SubmitButton>
    </form>
  );
}
