import type { Metadata } from "next";
import Link from "next/link";
import { FAQ, faqJsonLd, type FaqPart } from "@/lib/faq";
import { jsonLdScript } from "@/lib/jobs/job-posting";

export const metadata: Metadata = {
  title: "FAQ: finding a crypto job by proof of work",
  description:
    "Answers for candidates: how NextCryptoJob works, why no CV is needed, where the jobs come from, how the score works, privacy and wallets.",
};

const LINK = "font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand";

function Part({ part }: { part: FaqPart }) {
  if (typeof part === "string") return <>{part}</>;
  return part.href.startsWith("mailto:") ? (
    <a href={part.href} className={LINK}>
      {part.text}
    </a>
  ) : (
    <Link href={part.href} className={LINK}>
      {part.text}
    </Link>
  );
}

export default function FaqPage() {
  return (
    <section className="mx-auto max-w-2xl px-[clamp(16px,4vw,32px)] pt-10 pb-24 sm:pt-16">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(faqJsonLd()) }} />
      <h1 className="display text-title">FAQ</h1>
      <p className="mt-2 text-ink-muted">
        For candidates. Hiring?{" "}
        <Link href="/company" className={LINK}>
          See NextCryptoJob for companies
        </Link>
        .
      </p>

      <div className="mt-8 grid gap-6">
        {FAQ.map((item) => (
          <div key={item.q} className="grid gap-2 border-b border-line pb-6 last:border-b-0 last:pb-0">
            <h3 className="font-display text-xl font-extrabold">{item.q}</h3>
            <div className="grid gap-2 text-ink">
              {item.a.map((paragraph, i) => (
                <p key={i}>
                  {paragraph.map((part, j) => (
                    <Part key={j} part={part} />
                  ))}
                </p>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
