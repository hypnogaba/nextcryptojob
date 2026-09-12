"use client";

import { useActionState } from "react";
import { FormMessageLine } from "@/components/form/form-message";
import { SubmitButton } from "@/components/form/submit-button";
import { rescoreAction, type ProfileActionState } from "./actions";

/** «Try again» після збою або «Update my score»: нове завдання в черзі. */
export function RescoreButton({ label, variant = "default" }: { label: string; variant?: "default" | "outline" }) {
  const [state, action] = useActionState(rescoreAction, {} as ProfileActionState);
  return (
    <form action={action} className="grid gap-2">
      <SubmitButton variant={variant} pendingLabel="Queueing..." className="h-11 px-5 text-base">
        {label}
      </SubmitButton>
      <FormMessageLine message={state.message} />
    </form>
  );
}
