import type { Metadata } from "next";
import Link from "next/link";
import { CardBackFace } from "@/components/card/card-back";
import { CardFront } from "@/components/card/card-front";
import { MiniCard } from "@/components/card/mini-card";
import { SharePreview } from "@/components/landing/share-preview";
import { Button } from "@/components/ui/button";
import { builtFrom } from "@/lib/card/back";
import { EXAMPLE_BACK, EXAMPLE_BREAKDOWN, exampleFace } from "@/lib/card/example";
import { FINISHES } from "@/lib/card/tiers";

export const metadata: Metadata = {
  title: "How your score works",
  description:
    "Optional: your posts on X, your wallets' history and your GitHub become a 0 to 100 score for your role, on a card you can post on X.",
};

const WRAP = "mx-auto max-w-[1280px] px-[clamp(16px,4vw,32px)]";
const LINK = "font-semibold text-ink underline decoration-lemon decoration-2 underline-offset-4 hover:decoration-ink";

/**
 * Як працює бал, коротко (власник 14.09, A3: без десяти варіантів, просто розповісти, як
 * це працює). Картинка для X і три абзаци, кругла печатка рівня, розклад прикладу, хто бачить.
 * Формули й ваги кожної ролі: /how-scoring-works.
 */
export default function ScoringPage() {
  const face = exampleFace();
  const reasons = builtFrom(EXAMPLE_BACK) ?? "";

  return (
    <>
      <section className={`${WRAP} pt-6 pb-16 sm:pt-10`}>
        <div className="grid items-start gap-12 lg:grid-cols-[minmax(0,1fr)_360px]">
          <figure>
            <SharePreview face={face} reasons={reasons} />
            <figcaption className="mt-3 text-[0.8125rem] text-ink-muted">
              Your card as a 1200 × 675 image for X. The link preview crops it to 1200 × 630.
            </figcaption>
          </figure>
          <div>
            <h1 className="display text-title">How your score works</h1>
            <div className="mt-4 grid gap-3 text-ink-muted">
              <p>We read public data only: your posts on X, your wallets&apos; history and your GitHub.</p>
              <p>
                Each role weighs them differently.{" "}
                <b className="font-semibold text-ink">For an engineer, GitHub counts most. For a trader, your wallets do.</b>
              </p>
              <p>
                The score runs from 0 to 100, and every 10 points is a new level. A source you haven&apos;t linked stays
                empty. It never pulls you down.
              </p>
              <p>It is optional and free. Your daily jobs come with or without it.</p>
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-2">
              <Button asChild size="lg">
                <Link href="/login">Get started</Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link href="/how-scoring-works">Every formula and weight</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="seal-h" className={`${WRAP} pb-24`}>
        <div className="grid gap-10 border-t border-line pt-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)] lg:items-start">
          <div>
            <h2 id="seal-h" className="display text-section">
              Your level is a seal no one else has
            </h2>
            <p className="mt-4 max-w-[56ch] text-lg text-ink-muted">
              The seal is drawn from your card, so no two look alike. Every ten points adds a ring to it, and the card
              changes finish as you climb.
            </p>
            <ol className="mt-8 grid max-w-[560px] grid-cols-4 gap-4">
              {FINISHES.map((f) => (
                <li key={f.finish} className="grid justify-items-center gap-2 text-center">
                  <MiniCard level={f.sample} seed={face.sealSeed!} value={f.sample} className="w-full max-w-[112px]" />
                  <p className="text-[0.8125rem] leading-tight text-ink-muted">
                    <span className="font-semibold text-ink">{f.name}</span>
                    <br />
                    {f.levels}
                  </p>
                </li>
              ))}
            </ol>
          <div aria-labelledby="visible-h" className="mt-12 grid max-w-[64ch] gap-3 rounded-3xl bg-soft p-6 sm:p-8">
            <h2 id="visible-h" className="font-display text-2xl font-semibold">
              Companies can find you. You can hide any time.
            </h2>
            <p className="text-ink-muted">
              When you finish setting up, &quot;Show me to companies&quot; is on. Companies with access
              then see your scores, roles and level, your Telegram and your public links so they can message you directly.
              They never see your email unless you allow it. You can hide your profile any time in{" "}
              <Link href="/settings" className={LINK}>
                settings
              </Link>
              .
            </p>
          </div>
          </div>
          <div className="grid gap-6">
            <div className="ncj-card mx-auto max-w-[440px]">
              <CardFront face={face} draw spin />
            </div>
            <CardBackFace face={face} back={EXAMPLE_BACK} meta={`Formula ${EXAMPLE_BREAKDOWN.formula}. Example data.`} />
          </div>
        </div>
      </section>

    </>
  );
}
