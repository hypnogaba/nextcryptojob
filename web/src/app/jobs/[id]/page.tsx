import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { Check } from "lucide-react";
import { CompanySite, TokenBadge } from "@/components/jobs/job-card";
import { Button } from "@/components/ui/button";
import { ROLES } from "@/lib/card/roles";
import { countryName } from "@/lib/crm/countries";
import { placeText } from "@/lib/crm/jobs";
import { loadPublicJob, type PublicJobPage } from "@/lib/crm/public-jobs";
import { appEnv, db } from "@/lib/db";
import { formatSalary } from "@/lib/digest/format";
import { isId } from "@/lib/ids";
import { currentUser } from "@/lib/auth/session";
import { companyKey } from "@/lib/jobs/clean";
import { applyLink, jobVia } from "@/lib/jobs/link";
import { companyProfiles, profileFor } from "@/lib/jobs/companies";
import { NO_FIT, reasonsForRef } from "@/lib/jobs/instant";
import { jobPostingJsonLd, jsonLdScript } from "@/lib/jobs/job-posting";
import { isScannedJobId, loadScannedJob, type ScannedJobPage } from "@/lib/jobs/scanned-job";
import { tokenChip, type TokenChip } from "@/lib/jobs/token";
import { jobsDb } from "@/lib/jobs-db";
import { loadAnswers } from "@/lib/onboarding/store";
import { briefDone } from "@/lib/onboarding/steps";
import { siteOrigin } from "@/lib/site";

/**
 * Публічна сторінка вакансії (раунд 5, п.20): БУДЬ-ЯКА вакансія, не лише компаній у CRM.
 * - Вакансія компанії (специфікація CRM 5.6): опис, "Apply" через /jobs/<id>/apply (+1 до
 *   apply_clicks). Закрита, прихована, прострочена чи компанія без підписки: 404.
 * - Вакансія зі сканування (db/jobs jobs_cache): опису в базі немає (сканер його не зберігає),
 *   тож сторінка показує компанію, місце, зарплату, токен і причини підбору (коли людина ввійшла
 *   й підходить); "Apply" веде прямо на джерело (lib/jobs/link.ts вирішує rel, як і на картці).
 *   Стара, закрита за віком: 404, той самий текст.
 *
 * Сторінку не кешуємо: вакансія може зникнути (закрита, чи вийшла з вікна свіжості), а не
 * лишатись видимою до наступної збірки.
 */

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

const loadJob = cache(async (id: string): Promise<PublicJobPage | null> => (isId("job", id) ? loadPublicJob(db(), id) : null));
const loadScanned = cache(async (id: string): Promise<ScannedJobPage | null> => {
  if (!isScannedJobId(id)) return null;
  try {
    return await loadScannedJob(jobsDb(), id, await companyProfiles(jobsDb));
  } catch (e) {
    // Прив'язки JOBS_DB зараз нема чи вона не відповіла: сторінка каже "not found", не падає.
    console.warn(`/jobs/${id}: scanned job read failed (${e instanceof Error ? e.name : "unknown"})`);
    return null;
  }
});

const POSTED = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function summary(job: PublicJobPage): string {
  const place = placeText(job.workMode, job.city);
  const salary = job.salary ? formatSalary(job.salary) : null;
  const lead = [place, salary].filter(Boolean).join(", ");
  const text = job.description.replace(/\s+/g, " ").trim();
  const intro = `${job.company} is hiring: ${job.title}${lead ? ` (${lead})` : ""}.`;
  const full = text ? `${intro} ${text}` : intro;
  return full.length > 200 ? `${full.slice(0, 197).trimEnd()}...` : full;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const job = await loadJob(id);
  if (job) {
    const title = `${job.title} at ${job.company}`;
    const description = summary(job);
    const path = `/jobs/${job.id}`;
    return {
      title,
      description,
      alternates: { canonical: path },
      openGraph: { type: "website", siteName: "NextCryptoJob", url: path, title, description },
      twitter: { card: "summary", title, description },
    };
  }
  const scanned = await loadScanned(id);
  if (!scanned) return { title: "This job is closed", robots: { index: false, follow: true } };
  const title = `${scanned.title} at ${scanned.company}`;
  const description = `${scanned.company} is hiring: ${scanned.title}${scanned.location ? ` (${scanned.location})` : ""}.`;
  const path = `/jobs/${scanned.id}`;
  return {
    title,
    description,
    alternates: { canonical: path },
    // Скановане: ми не власники цієї вакансії, тож без OG/JobPosting (лише сторінка компанії).
    robots: { index: false, follow: true },
    openGraph: { type: "website", siteName: "NextCryptoJob", url: path, title, description },
    twitter: { card: "summary", title, description },
  };
}

/** Токен компанії, коли адреса ще не верифікована в CRM: реєстр бази вакансій (db/jobs 0004/0005). */
async function companyToken(company: string, verifiedDomain: string | null): Promise<{ token: TokenChip | null; site: string | null }> {
  const profiles = await companyProfiles(jobsDb);
  const known = profileFor(profiles, companyKey(company));
  return {
    token: tokenChip(known?.token, new Date()),
    site: known?.domain && known.domain !== verifiedDomain ? known.domain : null,
  };
}

/** Причини підбору для людину з сесії (item 20): лише коли анкета пройдена; інакше без розділу. */
async function reasonsFor(ref: string): Promise<string[] | null> {
  const user = await currentUser();
  if (!user) return null;
  const answers = await loadAnswers(db(), user.id);
  if (!briefDone(answers.step)) return null;
  return reasonsForRef(
    { db: db(), env: appEnv(), jobs: jobsDb, now: new Date() },
    ref,
    {
      roles: JSON.stringify(answers.roles),
      remote_mode: answers.remoteMode,
      city: answers.city,
      salary_min: answers.salaryMin,
      salary_currency: answers.salaryCurrency,
      role_text: answers.roleText,
    },
    NO_FIT,
  );
}

function Reasons({ reasons }: { reasons: string[] | null }) {
  if (!reasons || reasons.length === 0) return null;
  return (
    <section aria-labelledby="why-h" className="grid gap-2">
      <h2 id="why-h" className="text-xl font-semibold tracking-tight">
        Why this fits you
      </h2>
      <ul className="grid gap-2">
        {reasons.map((r) => (
          <li key={r} className="grid grid-cols-[20px_minmax(0,1fr)] gap-2 text-base leading-6 text-ink">
            <span aria-hidden="true" className="mt-px grid size-5 place-items-center rounded-full bg-soft">
              <Check className="size-3 text-ink" strokeWidth={3.5} />
            </span>
            <span>{r}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ScannedJobView({ job, reasons }: { job: ScannedJobPage; reasons: string[] | null }) {
  const apply = applyLink(job.url);
  return (
    <article className="mx-auto grid max-w-3xl gap-8 px-4 pt-10 pb-20 sm:px-6 sm:pt-16">
      <header className="grid gap-3">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-muted">
          <span className="font-medium text-ink">{job.company}</span>
          {job.site ? <CompanySite domain={job.site} /> : null}
          {job.token ? <TokenBadge token={job.token} /> : null}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight break-words sm:text-4xl">{job.title}</h1>
        {job.location || job.salary ? (
          <p className="text-base text-ink wrap-anywhere">{[job.location, job.salary].filter(Boolean).join(" · ")}</p>
        ) : null}
        {job.roleNames.length > 0 ? (
          <ul className="flex flex-wrap gap-2" aria-label="Roles">
            {job.roleNames.map((r) => (
              <li key={r} className="rounded-full border border-line bg-brand-soft px-2.5 py-0.5 text-xs font-medium text-ink">
                {r}
              </li>
            ))}
          </ul>
        ) : null}
        {job.postedAt ? <p className="font-mono text-xs text-ink-muted">Posted {POSTED.format(new Date(job.postedAt))}</p> : null}
      </header>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {apply ? (
          <Button asChild size="lg" className="h-11 w-full px-6 text-base sm:w-fit">
            <a href={apply.href} {...(apply.newTab ? { target: "_blank", rel: apply.rel ?? undefined } : {})}>
              {apply.label}
            </a>
          </Button>
        ) : null}
        <p className="text-sm text-ink-muted">
          You apply directly with {job.company}{apply?.via ? `, via ${apply.via}` : job.via ? `, via ${job.via}` : ""}.
        </p>
      </div>

      {job.about ? (
        <section aria-labelledby="about-company" className="grid gap-3">
          <h2 id="about-company" className="text-xl font-semibold tracking-tight">
            About {job.company}
          </h2>
          <p className="text-base leading-relaxed text-ink-muted wrap-anywhere">{job.about}</p>
        </section>
      ) : null}

      <Reasons reasons={reasons} />

      <footer className="grid gap-2 border-t border-line pt-6 text-sm text-ink-muted">
        <p>We do not have the full description for this one: it comes from {job.site ?? "the company's own listing"}, above.</p>
        <p>
          <Link href="/" className="font-medium text-brand underline underline-offset-4">
            Get crypto jobs that match your track record
          </Link>{" "}
          in a daily digest.
        </p>
      </footer>
    </article>
  );
}

export default async function PublicJobPageView({ params }: Props) {
  const { id } = await params;
  const job = await loadJob(id);
  if (job) {
    const place = placeText(job.workMode, job.city);
    const country = job.country ? countryName(job.country) : "";
    const salary = job.salary ? formatSalary(job.salary) : null;
    const facts = [place, country && !place.includes(country) ? country : null, salary].filter(Boolean) as string[];
    const ld = jobPostingJsonLd(job, siteOrigin(appEnv()));
    const { token, site } = await companyToken(job.company, job.companyDomainVerified ? job.companyDomain : null);

    return (
      <article className="mx-auto grid max-w-3xl gap-8 px-4 pt-10 pb-20 sm:px-6 sm:pt-16">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(ld) }} />
        <header className="grid gap-3">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-muted">
            <span className="font-medium text-ink">{job.company}</span>
            {job.companyDomainVerified && job.companyDomain ? (
              <span>{job.companyDomain} (domain verified)</span>
            ) : site ? (
              <CompanySite domain={site} />
            ) : null}
            {token ? <TokenBadge token={token} /> : null}
          </p>
          <h1 className="text-3xl font-semibold tracking-tight break-words sm:text-4xl">{job.title}</h1>
          {facts.length > 0 ? <p className="text-base text-ink wrap-anywhere">{facts.join(" · ")}</p> : null}
          <ul className="flex flex-wrap gap-2" aria-label="Roles">
            {job.roles.map((r) => (
              <li key={r} className="rounded-full border border-line bg-brand-soft px-2.5 py-0.5 text-xs font-medium text-ink">
                {ROLES[r].name}
              </li>
            ))}
          </ul>
          {job.postedAt ? <p className="font-mono text-xs text-ink-muted">Posted {POSTED.format(new Date(job.postedAt))}</p> : null}
        </header>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button asChild size="lg" className="h-11 w-full px-6 text-base sm:w-fit">
            <a href={`/jobs/${job.id}/apply`} rel="nofollow">
              Apply
            </a>
          </Button>
          <p className="text-sm text-ink-muted">You apply directly with {job.company}.</p>
        </div>

        {job.description.trim() ? (
          <section aria-labelledby="about-job" className="grid gap-3">
            <h2 id="about-job" className="text-xl font-semibold tracking-tight">
              About the job
            </h2>
            <div className="text-base leading-relaxed whitespace-pre-line text-ink wrap-anywhere">{job.description}</div>
          </section>
        ) : null}

        {job.tags.length > 0 ? (
          <ul className="flex flex-wrap gap-2" aria-label="Tags">
            {job.tags.map((t) => (
              <li key={t} className="rounded-full border border-line bg-wash px-2.5 py-0.5 text-xs text-ink wrap-anywhere">
                {t}
              </li>
            ))}
          </ul>
        ) : null}

        <Reasons reasons={await reasonsFor(`co:${job.id}`)} />

        <footer className="grid gap-2 border-t border-line pt-6 text-sm text-ink-muted">
          <p>Posted by {job.company} on NextCryptoJob.</p>
          <p>
            <Link href="/" className="font-medium text-brand underline underline-offset-4">
              Get crypto jobs that match your track record
            </Link>{" "}
            in a daily digest.
          </p>
        </footer>
      </article>
    );
  }

  const scanned = await loadScanned(id);
  if (!scanned) notFound();
  const reasons = await reasonsFor(`nr:${scanned.id}`);
  return <ScannedJobView job={scanned} reasons={reasons} />;
}
