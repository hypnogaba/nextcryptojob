"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const LINK =
  "-mr-2 inline-flex min-h-11 items-center px-2 text-[0.9375rem] font-semibold text-ink underline decoration-line-strong decoration-1 underline-offset-4 transition-colors hover:decoration-brand";
// «Jobs» з 768 px, решта з 1024 px: разом з назвою сайту на планшеті вони не вміщаються.
const NAV_LINK = "hidden min-h-11 items-center px-2 text-[0.9375rem] text-ink-muted transition-colors hover:text-ink";

const NAV = [
  { href: "/scoring", label: "How scoring works" },
  { href: "/company", label: "For companies" },
  { href: "/agents", label: "Agents" },
] as const;

/**
 * Пункти шапки й «Sign in» або «Account». Шапка в спільному layout, і перевірка
 * сесії на сервері зробила б динамічними всі сторінки. Тому стан питаємо в /api/me
 * з браузера, заново після кожного переходу: вхід і вихід закінчуються переходом
 * (/welcome, /). «Jobs» веде на свої вакансії, якщо людина ввійшла, інакше на
 * приклад сьогоднішнього списку на головній.
 */
export function HeaderNav() {
  const pathname = usePathname();
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/me", { cache: "no-store", signal: controller.signal })
      .then((res) => (res.ok ? (res.json() as Promise<{ signedIn?: boolean }>) : null))
      .then((body) => setSignedIn(body?.signedIn === true))
      .catch(() => {
        // Мережа чи перехід обірвали запит: лишаємо те, що показано.
      });
    return () => controller.abort();
  }, [pathname]);

  return (
    <>
      <Link href={signedIn ? "/jobs" : "/#today"} className={`${NAV_LINK} md:inline-flex`}>
        Jobs
      </Link>
      {NAV.map((item) => (
        <Link key={item.href} href={item.href} className={`${NAV_LINK} lg:inline-flex`}>
          {item.label}
        </Link>
      ))}
      {signedIn ? (
        <Link href="/account" className={LINK}>
          Account
        </Link>
      ) : (
        <Link href="/login" className={LINK}>
          Sign in
        </Link>
      )}
    </>
  );
}
