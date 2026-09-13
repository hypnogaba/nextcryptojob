import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AccessNotice } from "@/components/crm/access-notice";
import { CompanySwitcher } from "@/components/crm/company-switcher";
import { CrmNav, type NavItem } from "@/components/crm/crm-nav";
import { accessBannerText, StatusBanner } from "@/components/crm/status-banner";
import { loadCrm, pageAllowed, type CrmPage } from "./crm";

/**
 * Оболонка CRM: назва компанії (перемикач, якщо їх кілька), плашки стану й
 * доступу, навігація (специфікація 10.1). Пункти лише ті, що відкриті в цьому
 * стані компанії. Jobs і Developers додадуть T12 і T11 разом зі своїми сторінками.
 */

const NAV: { page: CrmPage; href: string; label: string }[] = [
  { page: "apply", href: "/company/apply", label: "Application" },
  { page: "dashboard", href: "/company/dashboard", label: "Dashboard" },
  { page: "search", href: "/company/search", label: "Search" },
  { page: "pipeline", href: "/company/pipeline", label: "Pipeline" },
  { page: "saved-searches", href: "/company/saved-searches", label: "Saved searches" },
  { page: "team", href: "/company/team", label: "Team" },
  { page: "billing", href: "/company/billing", label: "Billing" },
  { page: "settings", href: "/company/settings", label: "Settings" },
];

export default async function CrmLayout({ children }: { children: ReactNode }) {
  const view = await loadCrm();
  if (!view) redirect("/company/start");
  const { company, application, memberships } = view;
  const items: NavItem[] = NAV.filter((n) => pageAllowed(n.page, company))
    // Схвалена агенція заявки в меню вже не потребує.
    .filter((n) => n.page !== "apply" || company.status !== "active")
    .map(({ href, label }) => ({ href, label }));

  return (
    <>
      <div className="border-b border-line bg-surface">
        <div className="mx-auto grid max-w-5xl gap-3 px-4 pt-4 pb-2 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <CompanySwitcher current={{ id: company.id, name: company.name }} memberships={memberships} />
            <span className="text-xs text-ink-muted">
              {company.kind === "agency" ? "Recruiting agency" : "Company"}, {view.role === "owner" ? "owner" : "member"}
            </span>
          </div>
          <StatusBanner company={company} application={application} />
          <AccessNotice banner={accessBannerText(company, view.ctx.now)} />
          <CrmNav items={items} />
        </div>
      </div>
      {children}
    </>
  );
}
