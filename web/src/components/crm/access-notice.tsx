"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { AccessBanner } from "./status-banner";

/**
 * Плашка доступу в оболонці CRM. На сторінці оплати не повторюється: там свій
 * докладний стан підписки.
 */
export function AccessNotice({ banner }: { banner: AccessBanner | null }) {
  const pathname = usePathname();
  if (!banner || pathname.startsWith("/company/billing")) return null;
  return (
    <div
      role="status"
      className={
        banner.tone === "info"
          ? "flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg border border-line bg-brand-soft px-4 py-2 text-sm text-ink"
          : "flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg border border-line-strong bg-wash px-4 py-2 text-sm text-ink"
      }
    >
      <p>
        <span className="font-medium">{banner.title}</span>
        {banner.body ? <span className="text-ink-muted"> {banner.body}</span> : null}
      </p>
      <Link href={banner.link.href} className="inline-flex min-h-11 items-center font-medium text-brand underline underline-offset-4">
        {banner.link.label}
      </Link>
    </div>
  );
}
