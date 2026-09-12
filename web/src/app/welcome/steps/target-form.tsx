"use client";

import { useActionState } from "react";
import { FormMessageLine } from "@/components/form/form-message";
import { ERROR, HINT, LABEL, TEXTAREA } from "@/components/form/styles";
import { SubmitButton } from "@/components/form/submit-button";
import { TARGET_MAX } from "@/lib/onboarding/store";
import { saveTargetAction } from "../actions/answers";
import type { StepState } from "../flow";

export function TargetForm({ initial }: { initial: string }) {
  const [state, action] = useActionState(saveTargetAction, {} as StepState);
  const error = state.errors?.target;
  return (
    <form action={action} className="grid gap-3">
      <label htmlFor="target" className={LABEL}>
        In your own words
      </label>
      <textarea
        id="target"
        name="target"
        rows={4}
        maxLength={TARGET_MAX}
        required
        defaultValue={state.values?.target ?? initial}
        placeholder="For example: I write Solidity and want a smart contract role at a DeFi team."
        aria-invalid={error ? true : undefined}
        aria-describedby="target-hint target-error"
        className={TEXTAREA}
      />
      <p id="target-hint" className={HINT}>
        Any language is fine. We suggest roles from your answer, and you choose.
      </p>
      {error ? (
        <p id="target-error" role="alert" className={ERROR}>
          {error}
        </p>
      ) : null}
      <FormMessageLine message={state.message} />
      <SubmitButton pendingLabel="Saving..." className="h-11 text-base">
        Continue
      </SubmitButton>
    </form>
  );
}
