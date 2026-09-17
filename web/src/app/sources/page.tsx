import { LegalPage, legalMetadata } from "@/components/legal-page";
import { LEGAL_DOCS } from "@/lib/legal/docs";

export const metadata = legalMetadata(LEGAL_DOCS.sources);

export default function SourcesPage() {
  return <LegalPage doc={LEGAL_DOCS.sources} />;
}
