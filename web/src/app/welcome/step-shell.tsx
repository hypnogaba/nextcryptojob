import Link from "next/link";
import type { ReactNode } from "react";
import { prevStep, STEP_TITLES, STEPS, stepNumber, type Step } from "@/lib/onboarding/steps";

/** Рамка кроку: номер, смужка поступу, заголовок, пояснення і «Back». */
export function StepShell({
  step,
  editing,
  lead,
  children,
}: {
  step: Step;
  /** Анкету вже завершено: людина правує відповіді. */
  editing: boolean;
  lead?: ReactNode;
  children: ReactNode;
}) {
  const n = stepNumber(step);
  const back = prevStep(step);
  return (
    <section className="mx-auto max-w-xl px-4 pt-8 pb-20 sm:px-6 sm:pt-14">
      <div className="flex items-center justify-between gap-4">
        <p className="font-mono text-xs tracking-widest text-brand uppercase">
          Step {n} of {STEPS.length}
        </p>
        {editing ? (
          <Link
            href="/profile"
            className="-mr-2 inline-flex min-h-11 items-center rounded-sm px-2 text-sm font-medium text-ink-muted hover:text-ink"
          >
            Back to profile
          </Link>
        ) : null}
      </div>
      <div
        className="mt-3 h-1 overflow-hidden rounded-full bg-wash"
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin={1}
        aria-valuemax={STEPS.length}
        aria-valuenow={n}
      >
        <div className="h-full rounded-full bg-brand" style={{ width: `${(n / STEPS.length) * 100}%` }} />
      </div>

      <h1 className="mt-8 text-2xl font-semibold tracking-tight sm:text-3xl">{STEP_TITLES[step]}</h1>
      {lead ? <div className="mt-3 text-ink-muted">{lead}</div> : null}
      <div className="mt-8">{children}</div>

      {back ? (
        <Link
          href={`/welcome?step=${back}`}
          className="mt-6 -ml-2 inline-flex min-h-11 items-center rounded-sm px-2 text-sm font-medium text-ink-muted hover:text-ink"
        >
          Back
        </Link>
      ) : null}
    </section>
  );
}
