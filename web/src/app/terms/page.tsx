import { LegalPage, legalMetadata } from "@/components/legal-page";
import { LEGAL_DOCS } from "@/lib/legal/docs";

export const metadata = legalMetadata(LEGAL_DOCS.terms);

export default function TermsPage() {
  return <LegalPage doc={LEGAL_DOCS.terms} />;
}
