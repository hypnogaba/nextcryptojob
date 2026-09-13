import { countryName } from "@/lib/crm/countries";
import type { PublicJobPage } from "@/lib/crm/public-jobs";

/**
 * Розмітка schema.org JobPosting для публічної сторінки вакансії (/jobs/<id>), щоб
 * пошуковики показували її як вакансію: https://developers.google.com/search/docs/appearance/structured-data/job-posting
 *
 * Обов'язкові для Google: title, description, datePosted, hiringOrganization, jobLocation
 * (або jobLocationType TELECOMMUTE для віддаленої). Решта лише, коли компанія її дала:
 * відсутнє поле краще, ніж вигадане.
 */

export type JsonLd = Record<string, unknown>;

export function jobPostingJsonLd(job: PublicJobPage, origin: string): JsonLd {
  const url = `${origin}/jobs/${job.id}`;
  const ld: JsonLd = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: job.title,
    description: job.description.trim() || `${job.title} at ${job.company}.`,
    identifier: { "@type": "PropertyValue", name: job.company, value: job.id },
    url,
    directApply: false,
    hiringOrganization: {
      "@type": "Organization",
      name: job.company,
      // Домен лише перевірений (пошта власника на ньому): інакше компанія могла вписати чужий сайт.
      ...(job.companyDomain && job.companyDomainVerified ? { sameAs: `https://${job.companyDomain}` } : {}),
    },
  };
  if (job.postedAt) ld.datePosted = job.postedAt;
  if (job.expiresAt) ld.validThrough = job.expiresAt;

  if (job.workMode.includes("remote")) {
    ld.jobLocationType = "TELECOMMUTE";
    if (job.country) ld.applicantLocationRequirements = { "@type": "Country", name: countryName(job.country) || job.country };
  }
  if (job.workMode.includes("city") && job.city) {
    ld.jobLocation = {
      "@type": "Place",
      address: {
        "@type": "PostalAddress",
        addressLocality: job.city,
        ...(job.country ? { addressCountry: job.country } : {}),
      },
    };
  }

  const s = job.salary;
  if (s && s.currency && (s.min !== null || s.max !== null)) {
    const unitText = s.period === "month" ? "MONTH" : "YEAR";
    const value =
      s.min !== null && s.max !== null && s.max !== s.min
        ? { "@type": "QuantitativeValue", minValue: s.min, maxValue: s.max, unitText }
        : { "@type": "QuantitativeValue", value: s.max ?? s.min, unitText };
    ld.baseSalary = { "@type": "MonetaryAmount", currency: s.currency, value };
  }
  return ld;
}

/** JSON для <script type="application/ld+json">: «<» екрановано, тож текст компанії не закриє тег. */
export function jsonLdScript(ld: JsonLd): string {
  return JSON.stringify(ld).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
