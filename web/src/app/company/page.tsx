import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "For companies",
  description:
    "Search anonymous profiles of crypto candidates, scored from what they have shipped. Candidates choose to be visible and share their contact only when they accept your intro.",
};

const POINTS = [
  {
    title: "Scores built from real work",
    body: "Each candidate is scored for the roles they chose, from GitHub, X, onchain history and published work, with the reasons behind every number.",
  },
  {
    title: "Only people who want to be found",
    body: "Candidates switch visibility on themselves. You see scores, level, location and pay floor. No names, handles or wallets.",
  },
  {
    title: "Intros the candidate agrees to",
    body: "Send a short message about the role. If the candidate accepts within 14 days, you get their Telegram handle or email.",
  },
  {
    title: "A pipeline for your team and your agents",
    body: "Track candidates from Found to Hired with notes and tags. The same actions work through the REST API and MCP.",
  },
] as const;

const WRAP = "mx-auto max-w-[1240px] px-[clamp(16px,4vw,56px)]";
const LINK = "font-semibold text-ink underline decoration-line-strong decoration-1 underline-offset-4 hover:decoration-brand";

/** Публічна сторінка для компаній (специфікація CRM, 6.1). Статична: сесію не читає. */
export default function CompanyLandingPage() {
  return (
    <>
      <section className={`${WRAP} pt-12 pb-16 sm:pt-16 sm:pb-20`}>
        <h1 className="display max-w-[16ch] text-[clamp(2.75rem,1.2rem+5vw,6rem)] leading-[0.88]">
          Hire crypto talent by what they have shipped
        </h1>
        <p className="mt-6 max-w-[46ch] text-xl text-ink-muted">
          Find engineers, researchers, traders and growth people through scores built from their public track record.
          Reach them with an intro they choose to accept.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
          <Button asChild size="lg">
            <Link href="/company/start">Get started</Link>
          </Button>
          <Link href="/company/start?kind=agency" className={`inline-flex min-h-11 items-center ${LINK}`}>
            Recruiting agency? Apply
          </Link>
        </div>
      </section>

      <section aria-label="How it works" className={`${WRAP} pb-16 sm:pb-20`}>
        <ul className="grid gap-x-10 gap-y-8 sm:grid-cols-2">
          {POINTS.map((point) => (
            <li key={point.title} className="grid content-start gap-2 border-t-2 border-ink pt-4">
              <h2 className="font-sans text-lg font-semibold text-ink">{point.title}</h2>
              <p className="max-w-[52ch] text-ink-muted">{point.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="pricing" className="bg-sleeve py-16 sm:py-20">
        <div className={`${WRAP} grid gap-4`}>
          <h2 id="pricing" className="display text-section">
            Pricing
          </h2>
          <p className="max-w-[62ch] text-lg text-ink-muted">
            A subscription with a 14-day trial for the full CRM, or pay per request through the API with USDC (x402).
            Recruiting agencies apply first; we review applications within 2 business days.
          </p>
          <p className="max-w-[62ch] text-sm text-ink-muted">
            Hiring only: no resale and no bulk export of candidate data. Read the{" "}
            <Link href="/terms/companies" className={LINK}>
              Company Terms
            </Link>
            .
          </p>
        </div>
      </section>
    </>
  );
}
