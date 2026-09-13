import Link from "next/link";
import type { Application } from "@/lib/crm/agency";
import type { CompanyInfo } from "@/lib/crm/context";
import { fromSqlTime } from "@/lib/time";

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

export type AccessBanner = { tone: "info" | "warning"; title: string; body?: string; link: { href: string; label: string } };

const DAY_MS = 86_400_000;

/**
 * Плашка доступу активної компанії (специфікація 10.1): немає доступу, лише
 * читання без підписки, дні пробного. null, коли підписка звичайна або компанія
 * не active (тоді говорить statusBannerText).
 */
export function accessBannerText(
  company: Pick<CompanyInfo, "status" | "access" | "plan" | "subscription">,
  now: Date,
): AccessBanner | null {
  if (company.status !== "active") return null;
  const billing = { href: "/company/billing", label: "Go to billing" };
  if (company.access === "none") return { tone: "warning", title: "Your company does not have access yet.", link: billing };
  if (company.access === "pay_per_request") {
    return {
      tone: "info",
      title: "Read-only: no active subscription.",
      body: "Your agent can still search and request intros through the API, paying with x402.",
      link: billing,
    };
  }
  if (company.plan === "trial" && company.subscription?.periodEnd) {
    const n = Math.max(0, Math.ceil((fromSqlTime(company.subscription.periodEnd).getTime() - now.getTime()) / DAY_MS));
    return { tone: "info", title: `Trial: ${n} ${n === 1 ? "day" : "days"} left`, link: { href: "/company/billing", label: "Subscribe" } };
  }
  return null;
}

/**
 * Плашка "Your webhook is failing" (специфікація 7.6 і 10.1): подію не прийнято за
 * 6 спроб. Знімається, щойно приймач відповість 2xx або власник змінить адресу.
 */
export function WebhookFailingBanner({ company }: { company: Pick<CompanyInfo, "status" | "webhookFailingSince"> }) {
  if (company.status !== "active" || !company.webhookFailingSince) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg border border-line-strong bg-wash px-4 py-2 text-sm text-ink"
    >
      <p>
        <span className="font-medium">Your webhook is failing</span>
        <span className="text-ink-muted"> Intro events did not reach your endpoint after 6 tries.</span>
      </p>
      <Link href="/company/developers#webhook" className="inline-flex min-h-11 items-center font-medium text-brand underline underline-offset-4">
        Open Developers
      </Link>
    </div>
  );
}
