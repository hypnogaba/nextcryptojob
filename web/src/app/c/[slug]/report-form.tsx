"use client";

import { useActionState } from "react";
import { FormMessageLine } from "@/components/form/form-message";
import { SubmitButton } from "@/components/form/submit-button";
import { REPORT_REASONS } from "@/lib/card/report";
import { reportCardAction, type ReportState } from "./actions";

/** Тихе «Report this card» під карткою: розгортається лише на натискання. */
export function ReportForm({ slug }: { slug: string }) {
  const [state, action] = useActionState(reportCardAction, {} as ReportState);
  if (state.message?.tone === "success") return <FormMessageLine message={state.message} />;
  return (
    <details className="group text-sm text-ink-muted">
      <summary className="inline-flex min-h-11 cursor-pointer items-center font-semibold underline decoration-line-strong underline-offset-4 hover:text-ink">
        Report this card
      </summary>
      <form action={action} className="mt-2 grid gap-2">
        <input type="hidden" name="slug" value={slug} />
        <fieldset className="grid gap-1">
          <legend className="sr-only">Why</legend>
          {Object.entries(REPORT_REASONS).map(([key, label]) => (
            <label key={key} className="flex min-h-11 cursor-pointer items-center gap-3">
              <input type="radio" name="reason" value={key} required className="size-4 accent-[var(--brand)]" />
              <span className="text-ink">{label}</span>
            </label>
          ))}
        </fieldset>
        <SubmitButton variant="outline" pendingLabel="Sending..." className="h-11 w-fit px-5">
          Send report
        </SubmitButton>
        <FormMessageLine message={state.message} />
      </form>
    </details>
  );
}
