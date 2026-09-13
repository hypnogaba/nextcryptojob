import Link from "next/link";
import type { ReactNode } from "react";
import { prevStep, STEP_TITLES, STEPS, stepNumber, type Step } from "@/lib/onboarding/steps";

/** Рамка кроку: номер, сім поділок поступу (без заповненої доріжки), заголовок, пояснення і «Back». */
export function StepShell({
  step,
  editing,
  lead,
  notice,
  children,
}: {
  step: Step;
  /** Анкету вже завершено: людина правує відповіді. */
  editing: boolean;
  lead?: ReactNode;
  /** Короткий рядок над кроком, наприклад, коли можна буде оновити бал. */
  notice?: string | null;
  children: ReactNode;
}) {
  const n = stepNumber(step);
  const back = prevStep(step);
  return (
    <section className="mx-auto max-w-xl px-[clamp(16px,4vw,56px)] pt-8 pb-20 sm:pt-14">
      <div className="flex items-center justify-between gap-4">
        <p className="font-display text-lg font-extrabold tracking-[0.04em] text-ink uppercase">
          Step {n} <span className="text-ink-muted">of {STEPS.length}</span>
        </p>
        {editing ? (
          <Link
            href="/profile"
            className="-mr-2 inline-flex min-h-11 items-center px-2 text-sm font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand"
          >
            Back to profile
          </Link>
        ) : null}
      </div>
      <div
        className="mt-3 grid grid-cols-7 gap-1.5"
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin={1}
        aria-valuemax={STEPS.length}
        aria-valuenow={n}
      >
        {STEPS.map((s, i) => (
          <span key={s} className={i + 1 < n ? "h-0.5 bg-ink" : i + 1 === n ? "h-1 bg-brand" : "h-0.5 bg-line-strong/50"} />
        ))}
      </div>

      {notice ? (
        <p role="status" className="mt-6 rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink">
          {notice}
        </p>
      ) : null}
      <h1 className="display mt-8 text-title">{STEP_TITLES[step]}</h1>
      {lead ? <div className="mt-3 text-ink-muted">{lead}</div> : null}
      <div className="mt-8">{children}</div>

      {back ? (
        <Link
          href={`/welcome?step=${back}`}
          className="mt-6 -ml-2 inline-flex min-h-11 items-center px-2 text-sm font-semibold text-ink-muted hover:text-ink"
        >
          Back
        </Link>
      ) : null}
    </section>
  );
}
