import Link from "next/link";
import { cn } from "@/lib/utils";

/** Сторінки адмінки. Нова сторінка додається сюди, і посилання з'являється на всіх. */
export const ADMIN_PAGES = [
  { href: "/admin/companies", label: "Companies" },
  { href: "/admin/sources", label: "Job sources" },
  { href: "/admin/agency-applications", label: "Agency applications" },
  { href: "/admin/payments", label: "Payments" },
  { href: "/admin/jobs", label: "Company jobs" },
  { href: "/admin/x-queue", label: "X queue" },
] as const;

export type AdminPage = (typeof ADMIN_PAGES)[number]["href"];

/**
 * Перемикач сторінок адмінки: над заголовком на самих сторінках і в кабінеті.
 * Рядок вкладок, як меню CRM: поточна з рискою 2 px кольору тексту.
 * Показувати лише тому, хто пройшов currentAdmin() чи isAdminSession().
 */
export function AdminNav({ current, className = "mb-6" }: { current?: AdminPage; className?: string }) {
  return (
    <nav aria-label="Admin" className={cn("flex min-w-0 items-center gap-x-4 overflow-x-auto border-b border-line text-sm whitespace-nowrap", className)}>
      <span className="font-display text-base font-extrabold tracking-[0.04em] text-ink-muted uppercase">Admin</span>
      {ADMIN_PAGES.map((p) => (
        <Link
          key={p.href}
          href={p.href}
          aria-current={p.href === current ? "page" : undefined}
          className={cn(
            "inline-flex min-h-11 shrink-0 items-center border-b-2 font-semibold transition-colors",
            p.href === current ? "border-ink text-ink" : "border-transparent text-ink-muted hover:border-line-strong hover:text-ink",
          )}
        >
          {p.label}
        </Link>
      ))}
    </nav>
  );
}
