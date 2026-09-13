"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Стан сайту для статичних частин сторінки: чи є сесія і повідомлення на весь сайт
 * (/admin/settings). Шапка в спільному layout, і читання на сервері зробило б
 * динамічними всі сторінки, тож питаємо /api/me з браузера, заново після кожного
 * переходу. Шапка й повідомлення беруть одну відповідь: запит на перехід один.
 */

export type SiteState = {
  signedIn: boolean;
  notice: { message: string; level: "info" | "warning" } | null;
};

let last: { key: string; promise: Promise<SiteState | null> } | null = null;

function fetchState(key: string): Promise<SiteState | null> {
  if (last?.key === key) return last.promise;
  const promise = fetch("/api/me", { cache: "no-store" })
    .then((res) => (res.ok ? (res.json() as Promise<Partial<SiteState>>) : null))
    .then((body) => (body ? { signedIn: body.signedIn === true, notice: body.notice ?? null } : null))
    // Мережа чи перехід обірвали запит: лишаємо те, що показано.
    .catch(() => null);
  last = { key, promise };
  return promise;
}

/** Стан для поточної сторінки; null, поки відповіді ще немає (або вона не прийшла). */
export function useSiteState(): SiteState | null {
  const pathname = usePathname();
  const [state, setState] = useState<SiteState | null>(null);
  useEffect(() => {
    let alive = true;
    // Ключ: адреса й мить переходу з точністю до секунди. Шапка й повідомлення
    // монтуються в ту саму мить і ділять запит; наступний перехід питає знову.
    fetchState(`${pathname}@${Math.floor(Date.now() / 1000)}`).then((next) => {
      if (alive && next) setState(next);
    });
    return () => {
      alive = false;
    };
  }, [pathname]);
  return state;
}

/** Повідомлення на весь сайт під шапкою. Простий текст, React його екранує. */
export function SiteNotice() {
  const notice = useSiteState()?.notice;
  if (!notice) return null;
  return (
    <aside
      aria-label="Site notice"
      data-notice={notice.level}
      className={cn(
        "border-b px-[clamp(16px,4vw,56px)] py-2.5 text-sm",
        notice.level === "warning" ? "border-brand bg-brand-soft text-ink" : "border-line bg-wash text-ink",
      )}
    >
      <p className="mx-auto max-w-[1240px] break-words">
        {notice.level === "warning" ? <b className="mr-2 font-semibold">Notice:</b> : null}
        {notice.message}
      </p>
    </aside>
  );
}
