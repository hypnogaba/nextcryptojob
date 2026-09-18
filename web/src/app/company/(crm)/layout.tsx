import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AccessNotice } from "@/components/crm/access-notice";
import { CompanySwitcher } from "@/components/crm/company-switcher";
import { CrmNav, type NavItem } from "@/components/crm/crm-nav";
import { accessBannerText, StatusBanner, WebhookFailingBanner } from "@/components/crm/status-banner";
import { loadCrm, pageAllowed, type CrmPage } from "./crm";

/**
 * Оболонка CRM: назва компанії (перемикач, якщо їх кілька), плашки стану й
 * доступу, навігація (специфікація 10.1). Пункти лише ті, що відкриті в цьому
 * стані компанії.
 */

const NAV: { page: CrmPage; href: string; label: string }[] = [
  { page: "apply", href: "/company/apply", label: "Application" },
  { page: "dashboard", href: "/company/dashboard", label: "Dashboard" },
  { page: "shortlist", href: "/company/shortlist", label: "Shortlist" },
  { page: "search", href: "/company/search", label: "Search" },
  { page: "pipeline", href: "/company/pipeline", label: "Pipeline" },
  { page: "saved-searches", href: "/company/saved-searches", label: "Saved searches" },
  { page: "jobs", href: "/company/jobs", label: "Jobs" },
  { page: "team", href: "/company/team", label: "Team" },
  { page: "billing", href: "/company/billing", label: "Billing" },
  { page: "developers", href: "/company/developers", label: "Developers" },
  { page: "settings", href: "/company/settings", label: "Settings" },
  { page: "help", href: "/company/help", label: "Help" },
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
        <div className="mx-auto grid max-w-7xl grid-cols-1 gap-3 px-[clamp(16px,4vw,56px)] pt-5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <CompanySwitcher current={{ id: company.id, name: company.name }} memberships={memberships} />
            <span className="text-sm text-ink-muted">
              {company.kind === "agency" ? "Recruiting agency" : "Company"}, {view.role === "owner" ? "owner" : "member"}
            </span>
          </div>
          {company.isDemo ? (
            <p role="status" data-demo-banner="" className="rounded-lg border border-dashed border-brand bg-brand-soft px-3 py-2 text-sm text-ink">
              <b>Demo company.</b> Every candidate here is synthetic and visible only to demo companies. Intros are
              answered by the demo candidates themselves; nothing is sent to real people.
            </p>
          ) : null}
          <StatusBanner company={company} application={application} />
          <AccessNotice banner={accessBannerText(company, view.ctx.now)} />
          <WebhookFailingBanner company={company} />
          <CrmNav items={items} />
        </div>
      </div>
      {children}
    </>
  );
}
