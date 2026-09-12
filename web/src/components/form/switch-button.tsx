"use client";

import { useFormStatus } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * Перемикач, що відправляє свою форму. role="switch" з aria-checked: читач
 * екрана чує «увімкнено / вимкнено», а не «кнопка». Поки форма працює,
 * повзунок уже стоїть у новому положенні (оптимістично) і не натискається вдруге.
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
      className={cn(
        "relative inline-flex h-11 w-16 shrink-0 items-center rounded-full p-1 transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
        shown ? "bg-brand" : "bg-line-strong",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-9 rounded-full bg-surface shadow-sm transition-transform motion-reduce:transition-none",
          shown ? "translate-x-5" : "translate-x-0",
        )}
      />
    </button>
  );
}
