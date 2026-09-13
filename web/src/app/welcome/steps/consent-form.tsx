"use client";

import Link from "next/link";
import { useActionState } from "react";
import { ERROR } from "@/components/form/styles";
import { FormMessageLine } from "@/components/form/form-message";
import { SubmitButton } from "@/components/form/submit-button";
import { SCORING_CONSENT } from "@/lib/consent";
import { finishAction } from "../actions/finish";
import type { StepState } from "../flow";

export function ConsentForm({ granted }: { granted: boolean }) {
  const [state, action] = useActionState(finishAction, {} as StepState);
  const error = state.errors?.agree;
  return (
    <form action={action} className="grid gap-4">
      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface p-4">
        <input
          type="checkbox"
          name="agree"
          value="yes"
          required
          defaultChecked={granted}
          aria-invalid={error ? true : undefined}
          aria-describedby="agree-error"
          className="mt-0.5 size-5 shrink-0 accent-[var(--brand)]"
        />
        <span className="text-sm text-ink">
          {SCORING_CONSENT.text}{" "}
          <Link href="/privacy" className="font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand">
            Privacy
          </Link>
        </span>
      </label>
      {error ? (
        <p id="agree-error" role="alert" className={ERROR}>
          {error}
        </p>
      ) : null}
      <FormMessageLine message={state.message} />
      <SubmitButton pendingLabel="Finishing..." className="h-11 text-base">
        Finish and see my score
      </SubmitButton>
    </form>
  );
}
