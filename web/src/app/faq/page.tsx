import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "FAQ | NextCryptoJob",
  description: "Answers for candidates and companies: how the score works, privacy, deleting your account, why a wallet is asked for, and pricing.",
};

const LINK = "font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand";

function Q({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2 border-b border-line pb-6 last:border-b-0 last:pb-0">
      <h3 className="font-display text-xl font-extrabold">{q}</h3>
      <div className="grid gap-2 text-ink">{children}</div>
    </div>
  );
}

export default function FaqPage() {
  return (
    <section className="mx-auto max-w-2xl px-[clamp(16px,4vw,32px)] pt-10 pb-24 sm:pt-16">
      <h1 className="display text-title">FAQ</h1>

      <h2 className="mt-10 font-display text-2xl font-extrabold">For candidates</h2>
      <div className="mt-4 grid gap-6">
        <Q q="What do you read?">
          <p>
            Only what is public: your posts on X, your GitHub activity, and your wallets&apos; on-chain history. We never read private
            messages or anything you have not connected yourself.
          </p>
        </Q>
        <Q q="How does the score work?">
          <p>
            Each connected source becomes a 0 to 100 number, weighted by role, then combined into one score and a level from 1 to 10. The
            full breakdown, with sources and weights, is on{" "}
            <Link href="/how-scoring-works" className={LINK}>
              How your score works
            </Link>
            , and you can see it live at{" "}
            <Link href="/scoring" className={LINK}>
              /scoring
            </Link>
            .
          </p>
        </Q>
        <Q q="What about privacy, and deleting my account?">
          <p>
            Read our{" "}
            <Link href="/privacy" className={LINK}>
              privacy policy
            </Link>{" "}
            for what we store and why. You can delete your account, sources, scores, cards and consent history at any time from{" "}
            <Link href="/settings" className={LINK}>
              Settings
            </Link>
            . Cards you already shared stop updating but the public link keeps working until you delete it too.
          </p>
        </Q>
        <Q q="Why do you ask for a wallet address?">
          <p>
            A wallet&apos;s on-chain history (age, transactions, chains, trading) is public and hard to fake, so it counts toward roles
            like Trader, or as a bonus for most roles. We only read the address you paste; we never ask for a signature, a seed phrase or
            access to funds.
          </p>
        </Q>
        <Q q="How much does this cost?">
          <p>NextCryptoJob is free for candidates: connecting sources, getting a score, a card, and the daily job digest.</p>
        </Q>
      </div>

      <h2 className="mt-12 font-display text-2xl font-extrabold">For companies</h2>
      <div className="mt-4 grid gap-6">
        <Q q="What access do companies get?">
          <p>
            A subscription gives your team candidate search with the same score breakdown candidates see, direct or approval-based intro
            requests, and posting jobs on NextCryptoJob.
          </p>
        </Q>
        <Q q="What does it cost?">
          <p>$100 per month, plus VAT where it applies, for the whole team. Checkout shows the exact price in your currency.</p>
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

      <h2 className="mt-12 font-display text-2xl font-extrabold">Building on NextCryptoJob</h2>
      <p className="mt-4 text-ink">
        REST and MCP for job search and candidate search: see{" "}
        <Link href="/agents" className={LINK}>
          Agents
        </Link>
        .
      </p>
    </section>
  );
}
