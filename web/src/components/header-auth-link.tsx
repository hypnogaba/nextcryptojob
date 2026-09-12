"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const LINK =
  "-mr-3 inline-flex min-h-11 items-center rounded-md px-3 text-sm font-medium text-ink-muted transition-colors hover:text-ink";

/**
 * «Sign in» або «Account» у шапці. Шапка в спільному layout, і перевірка
 * сесії на сервері зробила б динамічними всі сторінки, зокрема головну.
 * Тому стан питаємо в /api/me з браузера, заново після кожного переходу:
 * вхід і вихід закінчуються переходом (/welcome, /).
 */
export function HeaderAuthLink() {
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

  return signedIn ? (
    <Link href="/account" className={LINK}>
      Account
    </Link>
  ) : (
    <Link href="/login" className={LINK}>
      Sign in
    </Link>
  );
}
