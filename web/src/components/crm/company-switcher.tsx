import Link from "next/link";
import { switchCompanyAction } from "@/app/company/(crm)/actions";
import type { Membership } from "@/lib/crm/company";

const STATUS_LABEL: Record<Membership["status"], string | null> = {
  active: null,
  pending_review: "Under review",
  suspended: "Suspended",
  rejected: "Not approved",
  closed: "Closed",
};

/**
 * Назва компанії в шапці CRM; якщо компаній кілька, це перемикач. Без JS:
 * <details> з формою на кожну компанію (server action ставить кукі ncj_company).
 */
export function CompanySwitcher({ current, memberships }: { current: { id: string; name: string }; memberships: Membership[] }) {
  const others = memberships.filter((m) => m.companyId !== current.id);
  if (others.length === 0) {
    return <p className="truncate text-lg font-semibold tracking-tight text-ink">{current.name}</p>;
  }
  return (
    <details className="group relative">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md text-lg font-semibold tracking-tight text-ink [&::-webkit-details-marker]:hidden">
        <span className="truncate">{current.name}</span>
        <span aria-hidden className="text-sm text-ink-muted transition-transform group-open:rotate-180">
          &#9662;
        </span>
        <span className="sr-only">Switch company</span>
      </summary>
      <div className="absolute left-0 z-20 mt-1 grid w-72 max-w-[calc(100vw-2rem)] gap-1 rounded-lg border border-line bg-surface p-2 shadow-lg">
        {memberships.map((m) => (
          <form key={m.companyId} action={switchCompanyAction}>
            <input type="hidden" name="company_id" value={m.companyId} />
            <button
              type="submit"
              aria-current={m.companyId === current.id ? "true" : undefined}
              className="flex min-h-11 w-full items-center justify-between gap-3 rounded-md px-3 text-left text-sm hover:bg-wash aria-[current]:bg-brand-soft"
            >
              <span className="truncate font-medium text-ink">{m.name}</span>
              <span className="shrink-0 text-xs text-ink-muted">
                {[m.role === "owner" ? "Owner" : "Member", STATUS_LABEL[m.status]].filter(Boolean).join(", ")}
              </span>
            </button>
          </form>
        ))}
        <Link href="/company/start" className="flex min-h-11 items-center rounded-md px-3 text-sm font-medium text-brand hover:bg-wash">
          New company
        </Link>
      </div>
    </details>
  );
}
