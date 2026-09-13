"use client";

import { useActionState, type ReactNode } from "react";
import { FormMessageLine } from "@/components/form/form-message";
import { SubmitButton } from "@/components/form/submit-button";
import { answerIntroAction, type IntroAnswerState } from "./actions";

/**
 * Три відповіді на запит. Кожна кнопка шле POST (server action) зі своїм
 * значенням decision; токен з листа йде прихованим полем, лише коли сесії немає.
 */
export function IntroAnswerForm({
  introId,
  token,
  acceptLabel,
  canAccept,
  preview,
}: {
  introId: string;
  token: string | null;
  acceptLabel: string;
  canAccept: boolean;
  /** Що побачить компанія після «так»; після відповіді ховається. */
  preview: ReactNode;
}) {
  const [state, action] = useActionState(answerIntroAction, {} as IntroAnswerState);
  const message = state.text ? { tone: state.tone ?? "info", text: state.text } : undefined;

  if (state.done) {
    return <FormMessageLine message={message} className="text-base" />;
  }

  return (
    <form action={action} className="grid gap-5">
      {preview}
      <input type="hidden" name="intro_id" value={introId} />
      {token ? <input type="hidden" name="t" value={token} /> : null}
      <div className="grid gap-3">
        <div className="flex flex-wrap gap-3">
          <SubmitButton
            name="decision"
            value="accept"
            disabled={!canAccept}
            pendingLabel="Sharing..."
            className="h-11 px-4 text-base"
          >
            {acceptLabel}
          </SubmitButton>
          <SubmitButton
            name="decision"
            value="decline"
            variant="outline"
            pendingLabel="Declining..."
            className="h-11 px-4 text-base"
          >
            Decline
          </SubmitButton>
        </div>
        <div>
          <SubmitButton
            name="decision"
            value="block"
            variant="link"
            pendingLabel="Declining..."
            className="-ml-2.5 h-11 px-2.5 text-sm text-ink-muted"
          >
            Decline and block this company
          </SubmitButton>
        </div>
        <FormMessageLine message={message} />
      </div>
    </form>
  );
}
