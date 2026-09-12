"use client";

import { useActionState, useState } from "react";
import { FormMessageLine } from "@/components/form/form-message";
import { ERROR, FIELD, HINT, LABEL } from "@/components/form/styles";
import { SubmitButton } from "@/components/form/submit-button";
import { deleteAccountAction, type SettingsState } from "./actions";

export function DeleteAccountForm() {
  const [state, action] = useActionState(deleteAccountAction, {} as SettingsState);
  const [typed, setTyped] = useState("");
  const error = state.errors?.confirm;
  return (
    <form action={action} className="grid gap-3">
      <p className={HINT}>
        This deletes your account, sources, collected data, scores, cards and consent history. Cards you shared stop
        working. This cannot be undone.
      </p>
      <div className="grid gap-1.5">
        <label htmlFor="confirm" className={LABEL}>
          Type DELETE to confirm
        </label>
        <input
          id="confirm"
          name="confirm"
          type="text"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "confirm-error" : undefined}
          className={`${FIELD} sm:max-w-xs`}
        />
        {error ? (
          <p id="confirm-error" role="alert" className={ERROR}>
            {error}
          </p>
        ) : null}
      </div>
      <div className="grid gap-2">
        <SubmitButton
          variant="destructive"
          pendingLabel="Deleting..."
          disabled={typed.trim() !== "DELETE"}
          className="h-11 w-full px-5 text-base sm:w-fit"
        >
          Delete my account
        </SubmitButton>
        <FormMessageLine message={state.message} />
      </div>
    </form>
  );
}
