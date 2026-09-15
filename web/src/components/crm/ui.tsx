import Link from "next/link";
import type { ReactNode } from "react";
import { STAGE_TEXT } from "@/lib/crm/labels";
import type { Stage } from "@/lib/crm/types";
import { cn } from "@/lib/utils";

/**
 * Дрібні спільні частини екранів CRM. Лише токени (globals.css), жодного
 * кольору в коді. Та сама мова, що на сторінках кандидата: заголовки вузьким
 * прописним Big Shoulders, панелі з лінією 1 px, посилання кольору тексту з
 * підкресленням, акцент лише на головній дії і на «Contact shared».
 */

export const LINK = "font-semibold text-ink underline decoration-line-strong decoration-1 underline-offset-4 hover:decoration-brand";
export const CARD = "rounded-xl border border-line bg-surface";
/** Обгортка сторінки CRM: ширину додає сторінка (max-w-3xl для форм, max-w-7xl = 1280px для контейнера). */
export const PAGE = "mx-auto grid grid-cols-1 gap-6 px-[clamp(16px,4vw,56px)] pt-8 pb-20 sm:pt-12";
/** Заголовок розділу (панелі) і менший, для панелей збоку й плиток. */
export const H2 = "display text-[1.75rem] leading-none";
export const H3 = "display text-[1.375rem] leading-none";

type Tone = "success" | "info" | "warning" | "error";

const TONES: Record<Tone, string> = {
  success: "border-ink bg-surface",
  info: "border-line bg-surface",
  warning: "border-line-strong bg-wash",
  error: "border-destructive/50 bg-surface",
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
      <h1 className="display min-w-0 text-title break-words">{children}</h1>
      {aside ? <div className="text-sm text-ink-muted">{aside}</div> : null}
    </div>
  );
}

/**
 * Етап картки словом; для "Declined" ще хто відмовив. Акцентом лише
 * "Contact shared": це єдиний етап, де компанія вже може писати людині.
 */
export function StageText({ stage, declinedBy, className }: { stage: Stage; declinedBy?: "candidate" | "company" | null; className?: string }) {
  return (
    <span
      className={cn(
        "font-semibold whitespace-nowrap",
        stage === "contact_shared" ? "text-brand" : stage === "declined" ? "text-ink-muted" : "text-ink",
        className,
      )}
    >
      {STAGE_TEXT[stage]}
      {stage === "declined" && declinedBy ? ` by ${declinedBy}` : null}
    </span>
  );
}

/** Тег: друкована мітка з кутом, як мітка на картці, не пігулка. */
export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-[3px] border border-line bg-wash px-1.5 py-0.5 text-xs font-medium text-ink", className)}>
      {children}
    </span>
  );
}

/** Немає доступу (специфікація 10.1). */
export function NoAccess() {
  return (
    <Notice tone="warning">
      <p className="font-semibold">Your company does not have access yet.</p>
      <p className="mt-2">
        <Link href="/company/billing" className={LINK}>
          Go to billing
        </Link>
      </p>
    </Notice>
  );
}

/** Порожній стан: що тут буде і що зробити далі. */
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="grid justify-items-start gap-2 rounded-xl border border-dashed border-line-strong p-6">
      <p className="font-semibold text-ink">{title}</p>
      {children ? <div className="text-sm text-ink-muted">{children}</div> : null}
    </div>
  );
}
