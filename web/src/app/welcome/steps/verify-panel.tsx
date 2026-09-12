"use client";

import { useActionState, useState } from "react";
import { FormMessageLine } from "@/components/form/form-message";
import { SubmitButton } from "@/components/form/submit-button";
import { Button } from "@/components/ui/button";
import { checkCodeAction } from "../actions/verify";
import type { StepState } from "../flow";

/** Код для біо, кнопка «Copy» і «Check». Спільне для X і GitHub. */
export function VerifyPanel({
  kind,
  code,
  claim,
  children,
}: {
  kind: "x" | "github";
  code: string;
  /** Нік, який людина забирає в неперевіреного профілю (код заявки), або нічого. */
  claim?: string;
  /** Інструкція: куди поставити код. */
  children: React.ReactNode;
}) {
  const [state, action] = useActionState(checkCodeAction, {} as StepState);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Без доступу до буфера людина перепише код сама.
    }
  }

  return (
    <div className="grid gap-4 rounded-xl border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <code className="font-mono text-xl tracking-wider text-ink select-all">{code}</code>
        <Button type="button" variant="outline" className="h-11 px-4" onClick={copy}>
          {copied ? "Copied" : "Copy code"}
        </Button>
      </div>
      <div className="text-sm text-ink-muted">{children}</div>
      <form action={action} className="grid gap-2">
        <input type="hidden" name="kind" value={kind} />
        {claim ? <input type="hidden" name="claim" value={claim} /> : null}
        <SubmitButton pendingLabel="Checking..." className="h-11 text-base">
          Check
        </SubmitButton>
        <FormMessageLine message={state.message} />
      </form>
    </div>
  );
}
