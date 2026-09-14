"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { ERROR, HINT } from "@/components/form/styles";
import { FormMessageLine } from "@/components/form/form-message";
import { SubmitButton } from "@/components/form/submit-button";
import { SCORING_CONSENT, WELCOME_SHARING } from "@/lib/consent";
import { finishAction } from "../actions/finish";
import type { StepState } from "../flow";

const LINK = "font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand";
const BOX = "mt-0.5 size-5 shrink-0 accent-[var(--brand)]";

/**
 * Згода на бал і, в першому проході, вибір для компаній (власник 14.09): видимість і нік
 * напряму увімкнено наперед, галку видно, текст простий. Друга галка «Only after I approve
 * each company» лишає людину видимою, але нік лише після «так». Без ніка в Telegram пояснюємо,
 * що компанія спершу попросить знайомство, а пошта без згоди не показується.
 */
export function ConsentForm({
  granted,
  editing = false,
  telegramHandle = null,
}: {
  granted: boolean;
  editing?: boolean;
  telegramHandle?: string | null;
}) {
  const [state, action] = useActionState(finishAction, {} as StepState);
  const [visible, setVisible] = useState(true);
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
          className={BOX}
        />
        <span className="text-sm text-ink">
          {SCORING_CONSENT.text}{" "}
          <Link href="/privacy" className={LINK}>
            Privacy
          </Link>
        </span>
      </label>
      {error ? (
        <p id="agree-error" role="alert" className={ERROR}>
          {error}
        </p>
      ) : null}

      {editing ? (
        <p className={HINT}>
          Who can see you and your Telegram:{" "}
          <Link href="/settings#companies-title" className={LINK}>
            Settings
          </Link>
          .
        </p>
      ) : (
        <fieldset className="grid gap-2 rounded-xl border border-line bg-surface p-4" data-sharing="">
          <legend className="sr-only">Companies</legend>
          <input type="hidden" name="sharing" value="yes" />
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              name="visible"
              value="yes"
              checked={visible}
              onChange={(e) => setVisible(e.target.checked)}
              aria-describedby="sharing-help"
              className={BOX}
            />
            <span className="text-sm text-ink">{WELCOME_SHARING.text}</span>
          </label>
          <label className="ml-8 flex cursor-pointer items-start gap-3 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60">
            <input type="checkbox" name="approval_only" value="yes" disabled={!visible} className={BOX} />
            <span className="grid gap-0.5 text-sm text-ink">
              {WELCOME_SHARING.approvalText}
              <span className={HINT}>Companies still find you, but see your Telegram only after you say yes to their request.</span>
            </span>
          </label>
          <p id="sharing-help" className={`${HINT} ml-8`}>
            {telegramHandle
              ? `Companies see ${telegramHandle}. Never your wallet addresses or email.`
              : "You have no Telegram username yet, so companies send you an intro request first. " +
                "We never show your email without your yes."}
          </p>
        </fieldset>
      )}

      <FormMessageLine message={state.message} />
      <SubmitButton pendingLabel="Finishing..." className="h-11 text-base">
        {editing ? "Save" : "Continue"}
      </SubmitButton>
    </form>
  );
}
