"use client";

import { ArrowRight, ChevronDown } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { useSiteState } from "@/components/site-state";

const NAV_LINK =
  "inline-flex min-h-10 items-center rounded-full px-3 max-sm:px-2 text-[0.9375rem] font-medium text-ink-muted transition-colors duration-300 hover:bg-soft hover:text-ink aria-[current=page]:bg-soft aria-[current=page]:text-ink";
const MENU_LINK = "block rounded-[10px] px-3 py-2.5 text-[0.9375rem] font-medium text-ink hover:bg-soft";
const PILL =
  "inline-flex min-h-10 items-center gap-2 rounded-[10px] px-4 max-sm:gap-1.5 max-sm:px-3 text-sm font-semibold whitespace-nowrap transition-colors duration-300";

/** Другорядне в одному меню «More» (власник 14.09, C1): сайт для пошуку роботи, решта окремо. */
const MORE = [
  { href: "/scoring", label: "How scoring works", note: "What we read and how the score adds up" },
  { href: "/company", label: "For companies", note: "Search candidates by proof" },
  { href: "/agents", label: "Agents", note: "API and MCP for AI agents" },
] as const;

/**
 * Шапка: «Jobs», «Your card», меню «More» і праворуч «Sign in» + «Find a job» або «Account».
 * Шапка в спільному layout, і перевірка сесії на сервері зробила б динамічними всі сторінки.
 * Тому стан питаємо в /api/me з браузера (components/site-state.tsx), заново після кожного
 * переходу. «Jobs» веде на свої вакансії, якщо людина ввійшла, інакше на приклад на головній.
 * На телефоні «Jobs» і «Your card» переходять у меню.
 */
export function HeaderNav() {
  const state = useSiteState();
  const signedIn = state?.signedIn === true;
  const pathname = usePathname();
  const more = useRef<HTMLDetailsElement>(null);

  // Меню закривається після переходу, кліку поза ним і Escape.
  useEffect(() => {
    if (more.current) more.current.open = false;
  }, [pathname]);
  useEffect(() => {
    const close = (e: Event) => {
      const el = more.current;
      if (!el?.open) return;
      if (e instanceof KeyboardEvent) {
        if (e.key !== "Escape") return;
        el.open = false;
        el.querySelector("summary")?.focus();
        return;
      }
      if (!el.contains(e.target as Node)) el.open = false;
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", close);
    };
  }, []);

  // /jobs сама показує запрошення створити профіль, коли людина не ввійшла (власник 15.09, п.9).
  const jobsHref = "/jobs";
  const current = (href: string) => (pathname === href ? "page" : undefined);

  return (
    <div className="flex items-center gap-0.5 sm:gap-2">
      <nav aria-label="Main" className="flex items-center gap-1">
        <Link href={jobsHref} aria-current={current("/jobs")} className={`${NAV_LINK} max-md:hidden`}>
          Jobs
        </Link>
        {signedIn ? (
          <Link href="/profile" aria-current={current("/profile")} className={`${NAV_LINK} max-md:hidden`}>
            Your card
          </Link>
        ) : null}
        <details ref={more} className="group relative">
          <summary
            className={`${NAV_LINK} cursor-pointer list-none gap-1.5 group-open:bg-soft group-open:text-ink [&::-webkit-details-marker]:hidden`}
          >
            More
            <ChevronDown aria-hidden className="size-4 transition-transform duration-300 group-open:rotate-180" />
          </summary>
          <div className="absolute top-[calc(100%+8px)] right-0 z-30 w-[260px] rounded-[18px] border border-line bg-surface p-2 shadow-[0_18px_40px_-16px_rgb(17_19_24/25%)] max-md:right-[-88px]">
            <Link href={jobsHref} className={`${MENU_LINK} md:hidden`}>
              Jobs
            </Link>
            {signedIn ? (
              <Link href="/profile" className={`${MENU_LINK} md:hidden`}>
                Your card
              </Link>
            ) : null}
            {MORE.map((item) => (
              <Link key={item.href} href={item.href} className={MENU_LINK}>
                {item.label}
                <small className="block text-[0.8125rem] leading-[1.125rem] font-normal text-ink-muted">{item.note}</small>
              </Link>
            ))}
            {state?.admin ? (
              // Адмін (пошта з ADMIN_EMAILS, вхід поштою): адмінка з будь-якої сторінки, і з телефона теж.
              <Link href="/admin" className={MENU_LINK}>
                Admin
              </Link>
            ) : null}
            {signedIn ? null : (
              <Link href="/login" className={`${MENU_LINK} sm:hidden`}>
                Sign in
              </Link>
            )}
          </div>
        </details>
      </nav>
      {signedIn ? (
        <Link href="/account" className={`${PILL} text-ink [box-shadow:inset_0_0_0_1.5px_var(--line)] hover:bg-soft`}>
          Account
        </Link>
      ) : (
        <>
          <Link
            href="/login"
            className={`${PILL} text-ink [box-shadow:inset_0_0_0_1.5px_var(--line)] hover:bg-soft max-sm:hidden`}
          >
            Sign in
          </Link>
          <Link href="/#find" className={`${PILL} bg-ink text-white hover:bg-brand-hover`}>
            Find a job
            <ArrowRight aria-hidden className="size-4 text-white" strokeWidth={2.5} />
          </Link>
        </>
      )}
    </div>
  );
}
