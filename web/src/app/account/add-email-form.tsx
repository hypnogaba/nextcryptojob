"use client";

import { useActionState, useEffect, useId, useRef } from "react";
import { FormMessageLine } from "@/components/form/form-message";
import { FIELD, HINT, LABEL } from "@/components/form/styles";
import { SubmitButton } from "@/components/form/submit-button";
import { cn } from "@/lib/utils";
import { addEmailAction, type AddEmailState } from "./email-actions";

const INITIAL: AddEmailState = { step: "email", email: "" };

/** Лишає в полі коду лише цифри: вставлене «123 456» чи «Code: 123456» стає 123456. */
function keepDigits(event: React.FormEvent<HTMLInputElement>) {
  const input = event.currentTarget;
  const digits = input.value.replace(/\D/g, "").slice(0, 6);
  if (digits !== input.value) input.value = digits;
}

/**
 * «Add email»: адреса, код з листа, готово. Для профілю без пошти (вхід лише
 * через Telegram). Після успіху сторінка перебудовується з новою поштою.
 */
export function AddEmailForm({ intro }: { intro?: string }) {
  const [state, formAction] = useActionState(addEmailAction, INITIAL);
  const codeRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const emailId = `${id}-email`;
  const codeId = `${id}-code`;
  const messageId = `${id}-message`;

  // Після невдалої спроби курсор повертається в поле коду.
  useEffect(() => {
    if (state.step === "code" && state.message?.tone === "error") codeRef.current?.focus();
  }, [state]);

  if (state.step === "done") return <FormMessageLine id={messageId} message={state.message} />;

  const invalid = state.message?.tone === "error";

  if (state.step === "email") {
    return (
      <form action={formAction} className="grid gap-2">
        <label htmlFor={emailId} className={LABEL}>
          Add an email
        </label>
        {intro ? <p className={HINT}>{intro}</p> : null}
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id={emailId}
            name="email"
            type="email"
            autoComplete="email"
            spellCheck={false}
            required
            defaultValue={state.email}
            placeholder="you@example.com"
            aria-invalid={invalid || undefined}
            aria-describedby={messageId}
            className={FIELD}
          />
          <SubmitButton
            name="intent"
            value="send"
            pendingLabel="Sending..."
            className="h-11 shrink-0 px-5 text-base"
          >
            Send code
          </SubmitButton>
        </div>
        <FormMessageLine id={messageId} message={state.message} />
      </form>
    );
  }

  return (
    <form action={formAction} className="grid gap-2">
      <input type="hidden" name="email" value={state.email} />
      <label htmlFor={codeId} className={LABEL}>
        6-digit code
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          ref={codeRef}
          id={codeId}
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          required
          autoFocus
          onInput={keepDigits}
          aria-invalid={invalid || undefined}
          aria-describedby={messageId}
          className={cn(FIELD, "font-mono text-lg tracking-[0.3em]")}
        />
        <SubmitButton
          name="intent"
          value="verify"
          pendingLabel="Checking..."
          className="h-11 shrink-0 px-5 text-base"
        >
          Add email
        </SubmitButton>
      </div>
      <FormMessageLine id={messageId} message={state.message} />
      <div className="-mx-3 flex flex-wrap justify-between">
        <SubmitButton
          name="intent"
          value="send"
          pendingLabel="Sending..."
          variant="link"
          formNoValidate
          className="h-11 px-3"
        >
          Send a new code
        </SubmitButton>
        <SubmitButton name="intent" value="change" variant="link" formNoValidate className="h-11 px-3">
          Use a different email
        </SubmitButton>
      </div>
    </form>
  );
}
