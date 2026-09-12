import { LegalPage, legalMetadata } from "@/components/legal-page";
import { LEGAL_DOCS } from "@/lib/legal/docs";

export const metadata = legalMetadata(LEGAL_DOCS.privacy);

export default function PrivacyPage() {
  return <LegalPage doc={LEGAL_DOCS.privacy} />;
}
