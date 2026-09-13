"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Лічильники прокручуються при першому показі. CSS грає анімацію з першого кадру, тож
 * табло, яке видно одразу, крутиться й без JS. Якщо ж на момент гідрації табло ще нижче
 * краю екрана (телефон), ставимо data-roll="wait": цифри стають на початок, поки їх не
 * видно, і знімаємо позначку, коли табло з'являється, тож анімація грає на очах.
 * Під prefers-reduced-motion нічого не робимо (CSS анімацію й так вимикає).
 */
export function RollOnView({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Верх табло вже на екрані: анімація відіграла або грає зараз.
    if (el.getBoundingClientRect().top < innerHeight - 40) return;
    el.dataset.roll = "wait";
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        delete el.dataset.roll;
        io.disconnect();
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
