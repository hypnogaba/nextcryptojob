import { plainText } from "./markdown";
import howScoring from "../../../content/legal/how-scoring-works.md?raw";
import privacy from "../../../content/legal/privacy-policy.md?raw";
import termsCandidates from "../../../content/legal/terms-candidates.md?raw";
import termsCompanies from "../../../content/legal/terms-companies.md?raw";

/**
 * Юридичні сторінки: копії docs/legal у web/content/legal (scripts/legal-content.mjs),
 * вбудовані в бандл як текст. Це чернетки для юриста: текст не правимо тут.
 */

export type LegalDoc = { path: string; file: string; source: string; description: string };

export const LEGAL_DOCS = {
  privacy: {
    path: "/privacy",
    file: "privacy-policy.md",
    source: privacy,
    description: "What personal data NextCryptoJob processes, why, who receives it and your rights.",
  },
  terms: {
    path: "/terms",
    file: "terms-candidates.md",
    source: termsCandidates,
    description: "Terms for candidates who use NextCryptoJob to find a job. Free for candidates.",
  },
  termsCompanies: {
    path: "/terms/companies",
    file: "terms-companies.md",
    source: termsCompanies,
    description: "Terms for companies and agencies that use the NextCryptoJob CRM, API and job posting.",
  },
  howScoring: {
    path: "/how-scoring-works",
    file: "how-scoring-works.md",
    source: howScoring,
    description: "Where your NextCryptoJob score comes from, what we look at and how to contest it.",
  },
} as const satisfies Record<string, LegalDoc>;

/** Назва документа: перший заголовок першого рівня. */
export function docTitle(source: string): string {
  const m = /^#\s+(.+)$/m.exec(source);
  return m ? plainText(m[1]).trim() : "NextCryptoJob";
}
