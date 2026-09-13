"use client";

import { useRef, useState, type PointerEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const MAX_TILT = 15;

/**
 * Картка з двома боками: нахил за вказівником (до 15°, 300 мс, перспектива
 * 1200 px, як в Atropos) і поворот на зворот натисканням або кнопкою.
 * Нахил лише для миші і вимкнений під prefers-reduced-motion; поворот тоді миттєвий.
 * Прихований бік має aria-hidden, кнопка називає, що покаже натискання.
 */
export function CardFlip({
  front,
  back,
  className,
  frontLabel = "Show how it was built",
  backLabel = "Show the front",
}: {
  front: ReactNode;
  back: ReactNode;
  className?: string;
  frontLabel?: string;
  backLabel?: string;
}) {
  const [flipped, setFlipped] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  function tilt(e: PointerEvent<HTMLDivElement>) {
    const el = ref.current;
    if (!el || e.pointerType !== "mouse" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    el.style.setProperty("--ry", `${((x - 0.5) * 2 * MAX_TILT).toFixed(2)}deg`);
    el.style.setProperty("--rx", `${((0.5 - y) * 2 * MAX_TILT).toFixed(2)}deg`);
    el.style.setProperty("--mx", `${(x * 100).toFixed(1)}%`);
    el.style.setProperty("--my", `${(y * 100).toFixed(1)}%`);
    el.dataset.tilting = "true";
  }

  function rest() {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty("--rx", "0deg");
    el.style.setProperty("--ry", "0deg");
    el.dataset.tilting = "false";
  }

  return (
    <div className={cn("ncj-stage grid justify-items-center gap-3", className)}>
      <div
        ref={ref}
        className="ncj-card ncj-flip cursor-pointer"
        data-flipped={flipped}
        onPointerMove={tilt}
        onPointerLeave={rest}
        onClick={() => setFlipped((f) => !f)}
      >
        <div className="ncj-side" aria-hidden={flipped}>
          {front}
        </div>
        <div className="ncj-side ncj-side-back" aria-hidden={!flipped}>
          {back}
        </div>
        <div className="ncj-glare" aria-hidden="true" />
      </div>
      <button
        type="button"
        onClick={() => setFlipped((f) => !f)}
        className="inline-flex min-h-11 items-center px-2 text-sm font-semibold text-ink underline decoration-line-strong decoration-1 underline-offset-4 hover:decoration-brand"
      >
        {flipped ? backLabel : frontLabel}
      </button>
    </div>
  );
}
