"use client";

import { useFormStatus } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * Перемикач, що відправляє свою форму (вигляд як у перемикача каналу в кабінеті).
 * role="switch" з aria-checked: читач екрана чує «увімкнено / вимкнено», а не
 * «кнопка». Поки форма працює, повзунок уже стоїть у новому положенні і не
 * натискається вдруге. Ціль натискання 44 px, сам повзунок менший.
 */
export function SwitchButton({
  checked,
  disabled,
  labelledBy,
  describedBy,
}: {
  checked: boolean;
  disabled?: boolean;
  labelledBy: string;
  describedBy?: string;
}) {
  const { pending } = useFormStatus();
  const shown = pending ? !checked : checked;
  return (
    <button
      type="submit"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-busy={pending || undefined}
      disabled={disabled || pending}
      className="inline-flex h-11 w-14 shrink-0 items-center justify-center rounded-full focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span aria-hidden className={cn("relative h-7 w-12 rounded-full transition-colors", shown ? "bg-brand" : "bg-line-strong")}>
        <span
          className={cn(
            "absolute top-1 left-1 size-5 rounded-full bg-surface shadow-sm transition-transform motion-reduce:transition-none",
            shown ? "translate-x-5" : "translate-x-0",
          )}
        />
      </span>
    </button>
  );
}
