import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { HINT } from "@/components/form/styles";
import { LeaveTeam } from "@/components/crm/leave-team";
import {
  ABOUT_MAX,
  CLOSE_CONFIRM_WORD,
  COMPANY_SWITCHED_TEXT,
  COMPANY_TERMS_VERSION,
  LAST_OWNER_TEXT,
  listActivity,
  loadCompanyProfile,
} from "@/lib/crm/company";
import { WEB_BURST_TEXT } from "@/lib/crm/context";
import { can } from "@/lib/crm/permissions";
import { COUNTRIES, countryName } from "@/lib/crm/countries";
import { fromSqlTime } from "@/lib/time";
import { crmPage } from "../crm";
import { CloseCompanyForm, CompanyProfileForm } from "./settings-forms";

export const metadata: Metadata = { title: "Company settings", robots: { index: false } };

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const TIME = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});
const LINK = "font-medium text-brand underline underline-offset-4";

const LEAVE_ERRORS: Record<string, string> = {
  last_owner: LAST_OWNER_TEXT,
  company_switched: COMPANY_SWITCHED_TEXT,
  unauthorized: "Sign in again to continue.",
  rate_limited: WEB_BURST_TEXT,
};

function Section({ id, title, intro, children }: { id: string; title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-4 rounded-xl border border-line bg-surface p-4 sm:p-6">
      <div className="grid gap-1">
        <h2 id={`${id}-title`} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        {intro ? <p className={HINT}>{intro}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[10rem_1fr] sm:gap-4">
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd className="text-ink">{children}</dd>
    </div>
  );
}

/**
 * Налаштування компанії (специфікація 10.2): профіль (власник змінює, член
 * бачить), стан домену, посилання на Developers (вебхук, ключі), журнал дій, закриття компанії.
 * Відкриті в будь-якому стані компанії, зокрема поки агенція на перевірці.
 */
export default async function CompanySettingsPage({
  searchParams,
}: {
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
} = {}) {
  const { ctx, role, company } = await crmPage("settings");
  const params = (await searchParams) ?? {};
  const error = Array.isArray(params.error) ? params.error[0] : params.error;
  const [profile, activity, owners] = await Promise.all([
    loadCompanyProfile(ctx.db, company.id),
    listActivity(ctx, 50),
    ctx.db
      .prepare("SELECT COUNT(*) AS n FROM company_members WHERE company_id = ? AND role = 'owner' AND user_id IS NOT NULL")
      .bind(company.id)
      .first<number>("n"),
  ]);
  if (!profile) return null;
  const isOwner = can(role, "settings.write");
  const editable = isOwner && (profile.status === "active" || profile.status === "pending_review");

  return (
    <div className="mx-auto grid max-w-3xl gap-6 px-4 pt-8 pb-20 sm:px-6 sm:pt-12">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Company settings</h1>
      {error ? (
        <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-ink">
          {LEAVE_ERRORS[error] ?? "Something went wrong. Try again."}
        </p>
      ) : null}

      <Section id="profile" title="Company profile" intro={isOwner ? undefined : "Only the owner can change these."}>
        {editable ? (
          <CompanyProfileForm
            companyId={company.id}
            countries={COUNTRIES}
            aboutMax={ABOUT_MAX}
            profile={{
              name: profile.name,
              website: profile.website ?? "",
              country: profile.country ?? "",
              about: profile.about ?? "",
              x_handle: profile.xHandle ? `@${profile.xHandle}` : "",
            }}
          />
        ) : (
          <dl className="grid gap-3">
            <Row label="Company name">{profile.name}</Row>
            <Row label="Website">{profile.website ?? "Not set"}</Row>
            <Row label="Country">{countryName(profile.country) || "Not set"}</Row>
            <Row label="About">{profile.about ?? "Not set"}</Row>
            <Row label="X handle">{profile.xHandle ? `@${profile.xHandle}` : "Not set"}</Row>
          </dl>
        )}
      </Section>

      <Section id="domain" title="Domain">
        <dl className="grid gap-3">
          <Row label="Domain">{profile.domain ?? "Not set"}</Row>
          <Row label="Status">
            {profile.domainVerifiedAt ? (
              <>Verified on {DATE.format(fromSqlTime(profile.domainVerifiedAt))}. Candidates see &quot;(domain verified)&quot;.</>
            ) : (
              <>
                Not verified. We verify the domain when the owner who sets the website signs in with an email on that
                domain. Free email services such as Gmail do not count.
              </>
            )}
          </Row>
          <Row label="Company Terms">
            Version {profile.termsVersion} accepted on {DATE.format(fromSqlTime(profile.termsAcceptedAt))}.{" "}
            <Link href="/terms/companies" className={LINK}>
              Read
            </Link>
            {profile.termsVersion !== COMPANY_TERMS_VERSION ? " A newer version exists." : null}
          </Row>
          {profile.kind === "agency" ? (
            <Row label="Agency application">
              <Link href="/company/apply" className={LINK}>
                View the application
              </Link>
            </Row>
          ) : null}
        </dl>
      </Section>

      <Section id="webhook" title="Webhook and API keys">
        <p className="text-sm text-ink">
          Set the webhook, create API keys and see recent deliveries on the{" "}
          <Link href="/company/developers" className={LINK}>
            Developers
          </Link>{" "}
          page.
        </p>
      </Section>

      <Section id="activity" title="Activity log" intro="Who did what in this company. Candidates appear only as a label like #3F9A1C.">
        {activity.length === 0 ? (
          <p className={HINT}>Nothing yet.</p>
        ) : (
          <ol className="grid gap-2">
            {activity.map((row, i) => (
              <li key={i} className="grid gap-0.5 border-b border-line pb-2 text-sm last:border-b-0 sm:grid-cols-[8rem_1fr] sm:gap-4">
                <time dateTime={fromSqlTime(row.at).toISOString()} className="font-mono text-xs text-ink-muted">
                  {TIME.format(fromSqlTime(row.at))} UTC
                </time>
                <span className="text-ink">
                  <span className="font-medium">{row.who}</span> {row.what}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Section>

      {/* Команда закрита, поки компанія не active: вийти можна звідси. */}
      {profile.status !== "active" ? (
        <LeaveTeam
          companyId={company.id}
          companyName={company.name}
          blocked={role === "owner" && profile.status !== "closed" && (owners ?? 0) <= 1}
          from="settings"
        />
      ) : null}

      {isOwner && profile.status !== "closed" ? (
        <Section id="close" title="Close company">
          <CloseCompanyForm word={CLOSE_CONFIRM_WORD} companyId={company.id} />
        </Section>
      ) : null}
    </div>
  );
}
