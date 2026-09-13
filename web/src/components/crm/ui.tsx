import Link from "next/link";
import type { ReactNode } from "react";
import { STAGE_TEXT } from "@/lib/crm/labels";
import type { Stage } from "@/lib/crm/types";
import { cn } from "@/lib/utils";

/**
 * Дрібні спільні частини екранів CRM (T7). Лише токени бренду (globals.css):
 * жодного кольору в коді, щоб новий дизайн змінив усе через токени.
 */

export const LINK = "font-medium text-brand underline underline-offset-4";
export const CARD = "rounded-xl border border-line bg-surface";

type Tone = "success" | "info" | "warning" | "error";

const TONES: Record<Tone, string> = {
  success: "border-line bg-brand-soft",
  info: "border-line bg-brand-soft",
  warning: "border-line-strong bg-wash",
  error: "border-destructive/40 bg-destructive/10",
};

/** Повідомлення сторінки: успіх і стан як status, помилка як alert. */
export function Notice({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cn("rounded-lg border px-4 py-3 text-sm text-ink", TONES[tone], className)}>
      {children}
    </div>
  );
}

export function PageTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{children}</h1>
      {aside ? <div className="text-sm text-ink-muted">{aside}</div> : null}
    </div>
  );
}

/** Етап картки; для "Declined" ще хто відмовив. */
export function StageChip({ stage, declinedBy, className }: { stage: Stage; declinedBy?: "candidate" | "company" | null; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
        stage === "declined" ? "border-line bg-wash text-ink-muted" : "border-line bg-brand-soft text-ink",
        className,
      )}
    >
      {STAGE_TEXT[stage]}
      {stage === "declined" && declinedBy ? ` by ${declinedBy}` : null}
    </span>
  );
}

export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border border-line bg-wash px-2.5 py-0.5 text-xs text-ink", className)}>
      {children}
    </span>
  );
}

/** Смужка 0–100 з числом поруч; значення без даних показується як n/a. */
export function ScoreBar({ value, label }: { value: number | null; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <div
        role="img"
        aria-label={value === null ? `${label}: no data` : `${label}: ${value} of 100`}
        className="h-2 w-24 shrink-0 overflow-hidden rounded-full bg-wash sm:w-32"
      >
        {value !== null ? <div className="h-full rounded-full bg-brand" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /> : null}
      </div>
      <span className="w-8 text-right font-mono text-sm tabular-nums text-ink">{value === null ? "n/a" : value}</span>
    </div>
  );
}

/** Немає доступу (специфікація 10.1). */
export function NoAccess() {
  return (
    <Notice tone="warning">
      <p className="font-medium">Your company does not have access yet.</p>
      <p className="mt-2">
        <Link href="/company/billing" className={LINK}>
          Go to billing
        </Link>
      </p>
    </Notice>
  );
}

/** Порожній стан: заголовок і пояснення, що робити далі. */
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className={cn(CARD, "grid gap-2 p-6 text-center")}>
      <p className="font-medium text-ink">{title}</p>
      {children ? <div className="text-sm text-ink-muted">{children}</div> : null}
    </div>
  );
}
