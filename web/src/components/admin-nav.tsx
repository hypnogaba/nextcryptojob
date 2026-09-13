import Link from "next/link";

/** Сторінки адмінки. Нова сторінка додається сюди, і посилання з'являється на всіх. */
export const ADMIN_PAGES = [
  { href: "/admin/companies", label: "Companies" },
  { href: "/admin/sources", label: "Job sources" },
  { href: "/admin/agency-applications", label: "Agency applications" },
  { href: "/admin/payments", label: "Payments" },
] as const;

export type AdminPage = (typeof ADMIN_PAGES)[number]["href"];

/**
 * Перемикач сторінок адмінки: над заголовком на самих сторінках і в кабінеті.
 * Показувати лише тому, хто пройшов currentAdmin() чи isAdminSession().
 */
export function AdminNav({ current, className = "mb-6" }: { current?: AdminPage; className?: string }) {
  return (
    <nav aria-label="Admin" className={`flex flex-wrap gap-x-4 gap-y-1 text-sm ${className}`}>
      <span className="self-center text-sm font-semibold text-ink-muted">Admin</span>
      {ADMIN_PAGES.map((p) => (
        <Link
          key={p.href}
          href={p.href}
          aria-current={p.href === current ? "page" : undefined}
          className={
            p.href === current
              ? "font-medium text-ink underline decoration-brand decoration-2 underline-offset-4"
              : "text-brand hover:underline"
          }
        >
          {p.label}
        </Link>
      ))}
    </nav>
  );
}
