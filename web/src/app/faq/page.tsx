import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "FAQ | NextCryptoJob",
  description:
    "Answers for candidates: how NextCryptoJob works, why no CV is needed, where the jobs come from, how the score works, privacy and wallets.",
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
      <p className="mt-2 text-ink-muted">
        For candidates. Hiring?{" "}
        <Link href="/company" className={LINK}>
          See NextCryptoJob for companies
        </Link>
        .
      </p>

      <div className="mt-8 grid gap-6">
        <Q q="How does NextCryptoJob work?">
          <p>
            Four steps. You tell us in your own words what job you want. We read the sources you connect, your X, your
            GitHub and your wallets, and turn them into a score for the role you want, with the full breakdown. We check
            crypto jobs every day and send you the ones that match, each with the reason it matched. You apply yourself,
            with one click, and the jobs you save stay in your account.
          </p>
        </Q>
        <Q q="Do I need a CV or a cover letter?">
          <p>
            No. We never ask for a CV, a cover letter or a motivation letter. Your profile is built from work you have
            already done and published, so there is nothing to write from scratch. A few short questions about the job
            you want is all we need.
          </p>
        </Q>
        <Q q="Where do the jobs come from, and how fresh are they?">
          <p>
            From the career pages of about 320 crypto employers, from crypto job boards, and from companies that post
            with us. We read every source once a day, keep jobs posted in the last 30 days, and drop duplicates, so the
            list you see is current, not a stale archive.
          </p>
        </Q>
        <Q q="Do you help me apply?">
          <p>
            We do the finding, the matching and the sorting: every job we send says why it fits your roles, your place
            and the pay you asked for. Applying stays with you, one click from the job page to the company, and your
            profile link is there to share instead of a CV. We do not apply on your behalf and we never message a company
            as you.
          </p>
        </Q>
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
        <Q q="How do I contact you?">
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
    </section>
  );
}
