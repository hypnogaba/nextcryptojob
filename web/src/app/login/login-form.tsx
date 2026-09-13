"use client";

import { useActionState, useEffect, useRef, type ComponentProps } from "react";
import { useFormStatus } from "react-dom";
import { FIELD } from "@/components/form/styles";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { loginAction, type LoginMessage, type LoginState } from "./actions";

const INITIAL: LoginState = { step: "email", email: "" };

/** Кнопка форми, що знає, чи зараз працює саме вона (з кількох у формі). */
function SubmitButton({
  intent,
  pendingLabel,
  children,
  ...props
}: ComponentProps<typeof Button> & { intent: string; pendingLabel?: string }) {
  const { pending, data } = useFormStatus();
  const mine = pending && data?.get("intent") === intent;
  return (
    <Button type="submit" name="intent" value={intent} disabled={pending} aria-busy={mine} {...props}>
      {mine && pendingLabel ? pendingLabel : children}
    </Button>
  );
}

function Message({ id, message }: { id: string; message?: LoginMessage }) {
  // Область завжди в DOM, щоб читач екрана оголошував зміну тексту.
  return (
    <p
      id={id}
      role={message?.tone === "error" ? "alert" : "status"}
      className={cn(
        "min-h-5 text-sm",
        message?.tone === "error" ? "text-destructive" : "text-ink-muted",
      )}
    >
      {message?.text}
    </p>
  );
}

/** Лишає в полі коду лише цифри: вставлене «123 456» чи «Code: 123456» стає 123456. */
function keepDigits(event: React.FormEvent<HTMLInputElement>) {
  const input = event.currentTarget;
  const digits = input.value.replace(/\D/g, "").slice(0, 6);
  if (digits !== input.value) input.value = digits;
}

export function LoginForm() {
  const [state, formAction] = useActionState(loginAction, INITIAL);
  const codeRef = useRef<HTMLInputElement>(null);

  // Після невдалої спроби курсор повертається в поле коду.
  useEffect(() => {
    if (state.step === "code" && state.message?.tone === "error") codeRef.current?.focus();
  }, [state]);

  if (state.step === "email") {
    const invalid = state.message?.tone === "error";
    return (
      <form action={formAction} className="mt-8 grid gap-3">
        <label htmlFor="email" className="text-sm font-semibold text-ink">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          spellCheck={false}
          required
          defaultValue={state.email}
          placeholder="you@example.com"
          aria-invalid={invalid || undefined}
          aria-describedby="email-message"
          className={FIELD}
        />
        <Message id="email-message" message={state.message} />
        <SubmitButton intent="send" pendingLabel="Sending..." className="h-11 text-base">
          Send code
        </SubmitButton>
      </form>
    );
  }

  const invalid = state.message?.tone === "error";
  return (
    <form action={formAction} className="mt-8 grid gap-3">
      <input type="hidden" name="email" value={state.email} />
      <label htmlFor="code" className="text-sm font-semibold text-ink">
        6-digit code
      </label>
      <input
        ref={codeRef}
        id="code"
        name="code"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        required
        autoFocus
        onInput={keepDigits}
        aria-invalid={invalid || undefined}
        aria-describedby="code-message"
        className={cn(FIELD, "font-mono text-lg tracking-[0.3em]")}
      />
      <Message id="code-message" message={state.message} />
      <SubmitButton intent="verify" pendingLabel="Signing in..." className="h-11 text-base">
        Sign in
      </SubmitButton>
      <div className="-mx-3 flex flex-wrap justify-between">
        <SubmitButton intent="send" pendingLabel="Sending..." variant="link" formNoValidate className="h-11 px-3">
          Send a new code
        </SubmitButton>
        <SubmitButton intent="change" variant="link" formNoValidate className="h-11 px-3">
          Use a different email
        </SubmitButton>
      </div>
    </form>
  );
}
