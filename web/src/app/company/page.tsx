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

const LINK = "font-medium text-brand underline underline-offset-4";

/** Публічна сторінка для компаній (специфікація CRM, 6.1). Статична: сесію не читає. */
export default function CompanyLandingPage() {
  return (
    <>
      <section className="mx-auto max-w-5xl px-4 pt-16 pb-12 sm:px-6 sm:pt-24">
        <p className="font-mono text-xs tracking-widest text-brand uppercase">For companies</p>
        <h1 className="mt-4 max-w-3xl text-3xl leading-tight font-semibold tracking-tight sm:text-5xl sm:leading-[1.1]">
          Hire crypto talent by what they have shipped
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-ink-muted">
          Find engineers, researchers, traders and growth people through scores built from their public track record.
          Reach them with an intro they choose to accept.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-4">
          <Button asChild size="lg" className="h-11 px-5 text-base">
            <Link href="/company/start">Get started</Link>
          </Button>
          <Link href="/company/start?kind=agency" className={`inline-flex min-h-11 items-center ${LINK}`}>
            Recruiting agency? Apply
          </Link>
        </div>
      </section>

      <section aria-label="How it works" className="mx-auto max-w-5xl px-4 pb-12 sm:px-6">
        <ol className="grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2">
          {POINTS.map((point, i) => (
            <li key={point.title} className="bg-surface p-5 sm:p-6">
              <span className="font-mono text-xs text-brand">0{i + 1}</span>
              <h2 className="mt-3 font-sans text-base font-semibold text-ink">{point.title}</h2>
              <p className="mt-2 text-sm text-ink-muted">{point.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="pricing" className="mx-auto max-w-5xl px-4 pb-20 sm:px-6 sm:pb-28">
        <div className="grid gap-4 rounded-xl border border-line bg-surface p-5 sm:p-6">
          <h2 id="pricing" className="text-lg font-semibold">
            Pricing
          </h2>
          <p className="text-ink-muted">
            A subscription with a 14-day trial for the full CRM, or pay per request through the API with USDC (x402).
            Recruiting agencies apply first; we review applications within 2 business days.
          </p>
          <p className="text-sm text-ink-muted">
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
