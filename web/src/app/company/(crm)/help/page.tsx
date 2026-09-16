import type { Metadata } from "next";
import Link from "next/link";
import { CARD, H2, LINK, PAGE, PageTitle } from "@/components/crm/ui";
import { crmPage } from "../crm";

export const metadata: Metadata = { title: "Help", robots: { index: false } };

/**
 * Кабінет компанії: «як це працює», FAQ компанії й API/Agents (п.9, 15.09: ціна й Agents/API
 * пішли з публічного /faq, який тепер лише для кандидатів; тут те саме, але для тих, хто вже
 * завів компанію). Відкрита завжди (як settings), незалежно від стану компанії.
 */

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className={`${CARD} scroll-mt-6 grid gap-4 p-4 sm:p-6`}>
      <h2 id={`${id}-h`} className={H2}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Q({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5 border-t border-line pt-4 first:border-t-0 first:pt-0">
      <h3 className="font-sans text-base font-semibold text-ink">{q}</h3>
      <div className="grid gap-2 text-[0.9375rem] text-ink-muted">{children}</div>
    </div>
  );
}

export default async function CompanyHelpPage() {
  await crmPage("help");

  return (
    <section className={`${PAGE} max-w-3xl`}>
      <PageTitle>Help</PageTitle>

      <Section id="how-it-works" title="How it works">
        <ol className="grid gap-3 text-[0.9375rem] text-ink">
          <li>
            <span className="font-semibold text-ink">Search</span> candidates by role, score, level, location and pay
            floor. Every candidate is visible unless they chose to hide.
          </li>
          <li>
            <span className="font-semibold text-ink">Open a profile</span> to see the same score breakdown the
            candidate sees: sources, weights and the reasons behind the number.
          </li>
          <li>
            <span className="font-semibold text-ink">Reach them.</span> If they share their Telegram, you see it and
            message them directly. Otherwise send a short note about the role; if they accept within 14 days, you
            get their contact.
          </li>
          <li>
            <span className="font-semibold text-ink">Track the pipeline</span> from Found to Hired, with notes and
            tags, in{" "}
            <Link href="/company/pipeline" className={LINK}>
              Pipeline
            </Link>
            .
          </li>
          <li>
            <span className="font-semibold text-ink">Post jobs</span> on NextCryptoJob from{" "}
            <Link href="/company/jobs" className={LINK}>
              Jobs
            </Link>
            ; matching candidates see them in their daily list.
          </li>
        </ol>
      </Section>

      <Section id="faq" title="FAQ">
        <div className="grid gap-4">
          <Q q="What access does a subscription give us?">
            <p>
              Candidate search with the same score breakdown candidates see, direct or approval-based intro
              requests, and posting jobs on NextCryptoJob, for the whole team.
            </p>
          </Q>
          <Q q="What does it cost?">
            <p>
              100 USDC a month, paid from your own wallet on Solana (Solana Pay), for the whole team. See{" "}
              <Link href="/company/billing" className={LINK}>
                Billing
              </Link>{" "}
              for the payment link and QR: payment in crypto, one payment for 30 days. Or pay per request through the
              API with USDC (x402), no subscription.
            </p>
          </Q>
          <Q q="Do you hold our funds or keys?">
            <p>
              No. Payment goes straight from your wallet to ours on Solana; we only read the chain to confirm it
              arrived. We never ask for a signature, a seed phrase or access to funds.
            </p>
          </Q>
          <Q q="What do we see about a candidate, and what don't we?">
            <p>
              Score, level, location, pay floor, and the reasons behind the score, sourced from what the candidate
              made public (GitHub, X, on-chain history, published work). We never show a name or wallet address, and
              a Telegram handle only if the candidate shares it. Candidates can hide from company search entirely.
            </p>
          </Q>
          <Q q="Recruiting agency?">
            <p>Apply first; we review applications within 2 business days. No resale and no bulk export of candidate data.</p>
          </Q>
          <Q q="How do we contact you?">
            <p>
              Write to{" "}
              <a href="mailto:hello@nextcryptojob.xyz" className={LINK}>
                hello@nextcryptojob.xyz
              </a>{" "}
              or use the{" "}
              <Link href="/contact" className={LINK}>
                contact form
              </Link>
              .
            </p>
          </Q>
        </div>
      </Section>

      <Section id="api" title="API and agents">
        <p className="text-[0.9375rem] text-ink-muted">
          REST and MCP cover the same actions as this CRM: search candidates, request intros, post jobs, read your
          pipeline. Manage keys and webhooks, and see request examples, in{" "}
          <Link href="/company/developers" className={LINK}>
            Developers
          </Link>
          . Full reference (OpenAPI, MCP tools, x402 payment) is at{" "}
          <Link href="/agents" className={LINK}>
            /agents
          </Link>
          .
        </p>
      </Section>
    </section>
  );
}
