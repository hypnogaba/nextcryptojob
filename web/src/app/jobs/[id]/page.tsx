import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { Button } from "@/components/ui/button";
import { ROLES } from "@/lib/card/roles";
import { countryName } from "@/lib/crm/countries";
import { placeText } from "@/lib/crm/jobs";
import { loadPublicJob, type PublicJobPage } from "@/lib/crm/public-jobs";
import { appEnv, db } from "@/lib/db";
import { formatSalary } from "@/lib/digest/format";
import { isId } from "@/lib/ids";
import { jobPostingJsonLd, jsonLdScript } from "@/lib/jobs/job-posting";
import { siteOrigin } from "@/lib/site";

/**
 * Публічна сторінка живої вакансії компанії (специфікація CRM 5.6): назва, компанія,
 * місце, зарплата, опис, "Apply" через /jobs/<id>/apply (+1 до apply_clicks). Закрита,
 * прихована адміном, прострочена чи компанія без підписки: 404 "This job is closed."
 * (not-found.tsx поруч). Розмітка JobPosting для пошуковиків (lib/jobs/job-posting.ts).
 *
 * Сторінку не кешуємо: закрита вакансія мусить зникнути одразу, а не з наступною збіркою.
 */

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

const loadJob = cache(async (id: string): Promise<PublicJobPage | null> => (isId("job", id) ? loadPublicJob(db(), id) : null));

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
  if (!job) return { title: "This job is closed", robots: { index: false, follow: true } };
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

export default async function PublicJobPageView({ params }: Props) {
  const { id } = await params;
  const job = await loadJob(id);
  if (!job) notFound();

  const place = placeText(job.workMode, job.city);
  const country = job.country ? countryName(job.country) : "";
  const salary = job.salary ? formatSalary(job.salary) : null;
  const facts = [place, country && !place.includes(country) ? country : null, salary].filter(Boolean) as string[];
  const ld = jobPostingJsonLd(job, siteOrigin(appEnv()));

  return (
    <article className="mx-auto grid max-w-3xl gap-8 px-4 pt-10 pb-20 sm:px-6 sm:pt-16">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(ld) }} />
      <header className="grid gap-3">
        <p className="text-sm text-ink-muted">
          <span className="font-medium text-ink">{job.company}</span>
          {job.companyDomainVerified && job.companyDomain ? (
            <span> · {job.companyDomain} (domain verified)</span>
          ) : null}
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
