import { LegalPage, legalMetadata } from "@/components/legal-page";
import { LEGAL_DOCS } from "@/lib/legal/docs";

export const metadata = legalMetadata(LEGAL_DOCS.termsCompanies);

export default function CompanyTermsPage() {
  return <LegalPage doc={LEGAL_DOCS.termsCompanies} />;
}
