import Link from "next/link";
import type { ReactNode } from "react";
import { prevStep, STEP_TITLES, stepPosition, type Step } from "@/lib/onboarding/steps";

const TOP_LINK =
  "-mr-2 inline-flex min-h-11 items-center px-2 text-sm font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand";

/**
 * Рамка кроку: номер у своїй частині (анкета з п'яти кроків або «Stand out» з трьох),
 * поділки поступу (без заповненої доріжки), заголовок, пояснення і «Back».
 */
export function StepShell({
  step,
  editing,
  lead,
  notice,
  children,
}: {
  step: Step;
  /** Крок уже пройдено: людина правує відповідь і повертається туди, звідки прийшла. */
  editing: boolean;
  lead?: ReactNode;
  /** Короткий рядок над кроком, наприклад, коли можна буде оновити бал. */
  notice?: string | null;
  children: ReactNode;
}) {
  const { part, n, of } = stepPosition(step);
  const brief = part === "brief";
  const back = prevStep(step);
  // Правка анкети веде до вакансій, правка джерел до профілю з балом.
  const home = brief ? { href: "/jobs", label: "Back to your jobs" } : { href: "/profile", label: "Back to profile" };
  return (
    <section className="mx-auto max-w-xl px-[clamp(16px,4vw,56px)] pt-8 pb-20 sm:pt-14">
      <div className="flex items-center justify-between gap-4">
        <p className="font-display text-lg font-extrabold tracking-[0.04em] text-ink uppercase">
          {brief ? "Step" : "Stand out"} {n} <span className="text-ink-muted">of {of}</span>
        </p>
        {editing ? (
          <Link href={home.href} className={TOP_LINK}>
            {home.label}
          </Link>
        ) : null}
      </div>
      <div
        // Класи повністю, щоб Tailwind їх побачив: 5 кроків анкети, 3 кроки «Stand out».
        className={`mt-3 grid gap-1.5 ${brief ? "grid-cols-5" : "grid-cols-3"}`}
        role="progressbar"
        aria-label={brief ? "Brief progress" : "Stand out progress"}
        aria-valuemin={1}
        aria-valuemax={of}
        aria-valuenow={n}
      >
        {Array.from({ length: of }, (_, i) => (
          <span key={i} className={i + 1 < n ? "h-0.5 bg-ink" : i + 1 === n ? "h-1 bg-brand" : "h-0.5 bg-line-strong/50"} />
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
      ) : !brief && !editing ? (
        <Link
          href="/jobs"
          className="mt-6 -ml-2 inline-flex min-h-11 items-center px-2 text-sm font-semibold text-ink-muted hover:text-ink"
        >
          Back to your jobs
        </Link>
      ) : null}
    </section>
  );
}
