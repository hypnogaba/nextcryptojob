import type { Metadata } from "next";
import Link from "next/link";
import { loadCompanyProfile } from "@/lib/crm/company";
import { COUNTRIES, countryName } from "@/lib/crm/countries";
import { fromSqlTime } from "@/lib/time";
import { crmPage } from "../crm";
import { ApplyForm } from "./apply-form";

export const metadata: Metadata = { title: "Agency application", robots: { index: false } };

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const LINK = "font-medium text-brand underline underline-offset-4";

/**
 * Заявка агенції (специфікація 6.2): форма, поки заявки немає або адмін
 * попросив більше; "Application received…" на перевірці; рішення після.
 */
export default async function ApplyPage() {
  const { ctx, user, role, company, application } = await crmPage("apply");
  const profile = await loadCompanyProfile(ctx.db, company.id);
  const canEdit = role === "owner" && company.status === "pending_review";
  const formOpen = canEdit && (!application || application.status === "needs_info");

  return (
    <section className="mx-auto grid max-w-2xl gap-6 px-4 pt-8 pb-20 sm:px-6 sm:pt-12">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Agency application</h1>

      {application?.status === "pending" ? (
        <div role="status" className="grid gap-1 rounded-xl border border-line bg-surface p-4 sm:p-6">
          <p className="text-lg font-semibold">Application received.</p>
          <p className="text-ink-muted">
            We review applications within 2 business days. We email the owners of {company.name} when we decide.
          </p>
          <p className="mt-2 text-sm text-ink-muted">Sent on {DATE.format(fromSqlTime(application.updatedAt))}.</p>
        </div>
      ) : null}

      {application?.status === "approved" || (company.kind === "agency" && company.status === "active") ? (
        <div role="status" className="grid gap-2 rounded-xl border border-line bg-surface p-4 sm:p-6">
          <p className="text-lg font-semibold">Your agency account is approved.</p>
          <p>
            <Link href="/company/billing?welcome=1" className={LINK}>
              Choose how to pay
            </Link>
          </p>
        </div>
      ) : null}

      {application?.status === "rejected" ? (
        <div role="status" className="grid gap-1 rounded-xl border border-line bg-surface p-4 sm:p-6">
          <p className="text-lg font-semibold">Your agency application was not approved.</p>
          {application.reviewerNote ? <p className="whitespace-pre-line text-ink-muted">{application.reviewerNote}</p> : null}
          <p className="mt-2 text-sm text-ink-muted">If you think this is a mistake, write to support@nextcryptojob.xyz.</p>
        </div>
      ) : null}

      {application?.status === "needs_info" ? (
        <div role="status" className="grid gap-1 rounded-xl border border-line-strong bg-wash p-4 sm:p-6">
          <p className="font-semibold">We need more information before we decide:</p>
          <p className="whitespace-pre-line text-ink">{application.reviewerNote}</p>
          <p className="mt-1 text-sm text-ink-muted">Update your answers below and send the application again.</p>
        </div>
      ) : null}

      {formOpen ? (
        <div className="grid gap-4 rounded-xl border border-line bg-surface p-4 sm:p-6">
          {!application ? (
            <p className="text-ink-muted">
              Tell us about {company.name}. We check that agencies recruit for real hiring processes before they can see
              candidates.
            </p>
          ) : null}
          <ApplyForm
            countries={COUNTRIES}
            resubmit={application?.status === "needs_info"}
            defaults={{
              contact_name: application?.contactName ?? "",
              contact_email: application?.contactEmail ?? user.email ?? "",
              website: application?.website ?? profile?.website ?? "",
              country: application?.country ?? profile?.country ?? "",
              clients_text: application?.clientsText ?? "",
              volume_text: application?.volumeText ?? "",
              data_use_text: application?.dataUseText ?? "",
            }}
          />
        </div>
      ) : null}

      {!formOpen && !application && company.status === "pending_review" ? (
        <p className="text-ink-muted">The owner of {company.name} has not sent the application yet.</p>
      ) : null}

      {application && application.status !== "needs_info" ? (
        <dl className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:p-6">
          <div>
            <dt className="text-ink-muted">Contact</dt>
            <dd className="text-ink">
              {application.contactName}, {application.contactEmail}
            </dd>
          </div>
          <div>
            <dt className="text-ink-muted">Website and country</dt>
            <dd className="text-ink">
              {application.website}, {countryName(application.country)}
            </dd>
          </div>
          <div>
            <dt className="text-ink-muted">Who you recruit for</dt>
            <dd className="whitespace-pre-line text-ink">{application.clientsText}</dd>
          </div>
          {application.volumeText ? (
            <div>
              <dt className="text-ink-muted">Hires per quarter</dt>
              <dd className="text-ink">{application.volumeText}</dd>
            </div>
          ) : null}
          <div>
            <dt className="text-ink-muted">How you will use candidate profiles</dt>
            <dd className="whitespace-pre-line text-ink">{application.dataUseText}</dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
}
