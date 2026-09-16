"use client";

import { useActionState, useState } from "react";
import { FormMessageLine } from "@/components/form/form-message";
import { ERROR, HINT, LABEL, TEXTAREA } from "@/components/form/styles";
import { SubmitButton } from "@/components/form/submit-button";
import { TARGET_MAX } from "@/lib/onboarding/store";
import { cn } from "@/lib/utils";
import { saveTargetAction } from "../actions/answers";
import type { StepState } from "../flow";

/**
 * Приклади відповіді: людина бачить, скільки й чого ми хочемо (роль, команда, де, скільки, одна
 * перемога). Натискання вставляє приклад у поле, щоб його переписати під себе.
 */
export const TARGET_EXAMPLES = [
  {
    label: "BD lead",
    text: "BD lead at a DeFi protocol, remote, from 3,000 EUR a month. I closed 20+ partnerships at my last project and know most L2 ecosystem teams.",
  },
  {
    label: "Solidity engineer",
    text: "Solidity engineer at a lending or DEX team, remote, from $90k a year. I shipped two audited protocols and contribute to Foundry.",
  },
  {
    label: "Community manager",
    text: "Community manager for a gaming or NFT project, remote, from 2,000 EUR a month. I grew a Discord from 0 to 40k members and ran weekly AMAs.",
  },
] as const;

/** Короткі відповіді дають слабкий здогад ролі; довгі не потрібні. */
const GOOD_MIN = 60;
const GOOD_MAX = 400;

export function lengthHint(n: number): { text: string; ok: boolean } {
  if (n === 0) return { text: `Aim for ${GOOD_MIN} to ${GOOD_MAX} characters: two or three sentences.`, ok: false };
  if (n < GOOD_MIN) return { text: `${n} characters. A bit short: add the pay you want and one thing you did.`, ok: false };
  if (n <= GOOD_MAX) return { text: `${n} characters. Good length.`, ok: true };
  return { text: `${n} of ${TARGET_MAX} characters. That is plenty, the first sentences matter most.`, ok: true };
}

export function TargetForm({ initial }: { initial: string }) {
  const [state, action] = useActionState(saveTargetAction, {} as StepState);
  const [text, setText] = useState(state.values?.target ?? initial);
  const error = state.errors?.target;
  const hint = lengthHint(text.trim().length);
  return (
    <form action={action} className="grid gap-5">
      <div className="grid gap-2">
        <p className={LABEL}>What to include</p>
        <ul className="grid gap-1 text-sm text-ink-muted sm:grid-cols-2">
          <li>1. The role you want</li>
          <li>2. The kind of team or project</li>
          <li>3. Remote or a city</li>
          <li>4. The pay you want, a month or a year</li>
          <li className="sm:col-span-2">5. One thing you did that shows you can do it</li>
        </ul>
      </div>

      <div className="grid gap-2">
        <label htmlFor="target" className={LABEL}>
          In your own words
        </label>
        <textarea
          id="target"
          name="target"
          rows={5}
          maxLength={TARGET_MAX}
          required
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={`For example: ${TARGET_EXAMPLES[0].text}`}
          aria-invalid={error ? true : undefined}
          aria-describedby="target-hint target-error"
          className={cn(TEXTAREA, "ncj-role-active")}
        />
        <p id="target-hint" aria-live="polite" className={cn(HINT, hint.ok && "text-ink")}>
          {hint.text} Any language is fine.
        </p>
        {error ? (
          <p id="target-error" role="alert" className={ERROR}>
            {error}
          </p>
        ) : null}
      </div>

      <div className="grid gap-2">
        <p className={LABEL}>Or start from an example</p>
        <div className="grid gap-2">
          {TARGET_EXAMPLES.map((ex) => (
            <button
              key={ex.label}
              type="button"
              onClick={() => setText(ex.text)}
              className="grid gap-0.5 rounded-xl border border-line bg-surface px-3 py-2.5 text-left transition-colors hover:border-ink focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none"
            >
              <span className="text-sm font-semibold text-ink">{ex.label}</span>
              <span className="text-sm text-ink-muted">{ex.text}</span>
            </button>
          ))}
        </div>
        <p className={HINT}>Pick one and change it to fit you. We read roles, place and pay from it.</p>
      </div>

      <FormMessageLine message={state.message} />
      <SubmitButton pendingLabel="Saving..." className="h-11 text-base">
        Continue
      </SubmitButton>
    </form>
  );
}
