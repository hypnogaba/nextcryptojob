"use client";

import { useActionState } from "react";
import { FormMessageLine } from "@/components/form/form-message";
import { ERROR, HINT } from "@/components/form/styles";
import { SubmitButton } from "@/components/form/submit-button";
import { setContactModeAction, type SettingsState } from "./actions";

const RADIO_ROW =
  "flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface p-3 " +
  "has-[:checked]:border-ink has-[:checked]:shadow-[inset_0_0_0_1px_var(--ink)] " +
  "has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60";

export function ContactForm({
  mode,
  telegramHandle,
  telegramLinked,
}: {
  mode: "approval" | "direct";
  telegramHandle: string | null;
  telegramLinked: boolean;
}) {
  const [state, action] = useActionState(setContactModeAction, {} as SettingsState);
  const canDirect = telegramLinked && telegramHandle !== null;
  const error = state.errors?.mode;
  return (
    <form action={action} className="grid gap-4">
      <fieldset className="grid gap-2" aria-describedby={error ? "mode-error" : undefined}>
        <legend className="sr-only">How companies reach you</legend>
        <label className={RADIO_ROW}>
          <input
            type="radio"
            name="mode"
            value="approval"
            defaultChecked={mode === "approval"}
            className="mt-1 size-5 shrink-0 accent-[var(--brand)]"
          />
          <span className="grid gap-0.5">
            <span className="text-base text-ink">Only after I approve a request</span>
            <span className={HINT}>
              You see each request with the company and the role, and answer yes or no. Recommended.
            </span>
          </span>
        </label>
        <label className={RADIO_ROW}>
          <input
            type="radio"
            name="mode"
            value="direct"
            defaultChecked={mode === "direct"}
            disabled={!canDirect}
            className="mt-1 size-5 shrink-0 accent-[var(--brand)]"
          />
          <span className="grid gap-0.5">
            <span className="text-base text-ink">Show my Telegram handle directly</span>
            <span className={HINT}>
              {canDirect
                ? `Every company that can see your profile also sees @${telegramHandle}, without asking you first.`
                : telegramLinked
                  ? "Your Telegram account has no username. Set one in Telegram to use this."
                  : "Connect Telegram on your account page to use this."}
            </span>
          </span>
        </label>
        {error ? (
          <p id="mode-error" role="alert" className={ERROR}>
            {error}
          </p>
        ) : null}
      </fieldset>
      <div className="grid gap-2">
        <SubmitButton pendingLabel="Saving..." variant="outline" className="h-11 w-full px-5 text-base sm:w-fit">
          Save
        </SubmitButton>
        <FormMessageLine message={state.message} />
      </div>
    </form>
  );
}
