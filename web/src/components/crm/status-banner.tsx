import Link from "next/link";
import type { Application } from "@/lib/crm/agency";
import type { CompanyInfo } from "@/lib/crm/context";

const LINK = "font-medium text-brand underline underline-offset-4";

/** Текст плашки стану компанії на всіх сторінках CRM (специфікація 6.2, 10.1); null, коли все гаразд. */
export function statusBannerText(
  company: Pick<CompanyInfo, "status" | "kind">,
  application: Pick<Application, "status" | "reviewerNote"> | null,
): { tone: "info" | "warning"; title: string; body?: string; link?: { href: string; label: string } } | null {
  switch (company.status) {
    case "active":
      return null;
    case "pending_review":
      if (company.kind === "agency" && !application) {
        return {
          tone: "warning",
          title: "Finish your agency application to get access.",
          link: { href: "/company/apply", label: "Open the application" },
        };
      }
      if (application?.status === "needs_info") {
        return {
          tone: "warning",
          title: "We need more information about your agency.",
          body: application.reviewerNote ?? undefined,
          link: { href: "/company/apply", label: "Update the application" },
        };
      }
      return {
        tone: "info",
        title: "Application received. We review applications within 2 business days.",
        body: "Until then only company settings are open.",
      };
    case "rejected":
      return {
        tone: "warning",
        title: "Your agency application was not approved.",
        body: application?.reviewerNote ?? undefined,
      };
    case "suspended":
      return { tone: "warning", title: "Your company account is suspended. Contact support@nextcryptojob.xyz." };
    case "closed":
      return {
        tone: "warning",
        title: "This company is closed.",
        body: "Its data is deleted 30 days after closing.",
        link: { href: "/company/start", label: "Start a new company" },
      };
  }
}

export function StatusBanner({ company, application }: { company: Pick<CompanyInfo, "status" | "kind">; application: Application | null }) {
  const b = statusBannerText(company, application);
  if (!b) return null;
  return (
    <div
      role="status"
      className={
        b.tone === "info"
          ? "rounded-lg border border-line bg-brand-soft px-4 py-3 text-sm text-ink"
          : "rounded-lg border border-line-strong bg-wash px-4 py-3 text-sm text-ink"
      }
    >
      <p className="font-medium">{b.title}</p>
      {b.body ? <p className="mt-1 whitespace-pre-line text-ink-muted">{b.body}</p> : null}
      {b.link ? (
        <p className="mt-2">
          <Link href={b.link.href} className={LINK}>
            {b.link.label}
          </Link>
        </p>
      ) : null}
    </div>
  );
}
