import { plainText } from "./markdown";
import howScoring from "../../../content/legal/how-scoring-works";
import privacy from "../../../content/legal/privacy-policy";
import sources from "../../../content/legal/sources";
import termsCandidates from "../../../content/legal/terms-candidates";
import termsCompanies from "../../../content/legal/terms-companies";

/**
 * Юридичні сторінки: копії docs/legal у web/content/legal (scripts/legal-content.mjs),
 * модулі з рядком, вбудовані в бандл. Це чернетки для юриста: текст не правимо тут.
 */

export type LegalDoc = { path: string; file: string; source: string; description: string };

export const LEGAL_DOCS = {
  privacy: {
    path: "/privacy",
    file: "privacy-policy.md",
    source: privacy,
    description: "What personal data NextCryptoJob processes, why, who receives it and what rights you have. Read how to see, fix or remove your data.",
  },
  terms: {
    path: "/terms",
    file: "terms-candidates.md",
    source: termsCandidates,
    description: "Terms for candidates who use NextCryptoJob to find a crypto job: what the service does, what you agree to and what we expect. Free for candidates.",
  },
  termsCompanies: {
    path: "/terms/companies",
    file: "terms-companies.md",
    source: termsCompanies,
    description: "Terms for companies and agencies that use the NextCryptoJob candidate search, API and job posting: access, payment, data use and contact rules.",
  },
  sources: {
    path: "/sources",
    file: "sources.md",
    source: sources,
    description: "Where the crypto jobs on NextCryptoJob come from, how our crawler behaves, and how a job board or company can ask us to change or stop.",
  },
  howScoring: {
    path: "/how-scoring-works",
    file: "how-scoring-works.md",
    source: howScoring,
    description: "Where your NextCryptoJob score comes from: what we read on X, GitHub and wallets, how it is weighed for your role, and how to contest it.",
  },
} as const satisfies Record<string, LegalDoc>;

/** Назва документа: перший заголовок першого рівня. */
export function docTitle(source: string): string {
  const m = /^#\s+(.+)$/m.exec(source);
  return m ? plainText(m[1]).trim() : "NextCryptoJob";
}
