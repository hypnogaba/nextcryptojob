import type { Metadata } from "next";
import { ComingSoon } from "@/components/coming-soon";

export const metadata: Metadata = { title: "Privacy" };

export default function PrivacyPage() {
  return <ComingSoon title="Privacy policy" />;
}
