import type { Metadata } from "next";
import Link from "next/link";
import { CardBackFace } from "@/components/card/card-back";
import { CardFlip } from "@/components/card/card-flip";
import { CardFront } from "@/components/card/card-front";
import { MiniCard } from "@/components/card/mini-card";
import { SharePreview } from "@/components/landing/share-preview";
import { Button } from "@/components/ui/button";
import { builtFrom } from "@/lib/card/back";
import { EXAMPLE_BACK, EXAMPLE_BREAKDOWN, exampleFace } from "@/lib/card/example";
import { ROLES } from "@/lib/card/roles";
import { levelRange, tierFor } from "@/lib/card/tiers";
import { POSITION_CODE, recipeBonus, recipeCore, SCORED_ROLE_KEYS } from "@/lib/roles/recipes";

export const metadata: Metadata = {
  title: "Your score and card",
  description:
    "Optional: GitHub, X and your wallets become a 0 to 100 score for one of ten crypto roles, with the math on the back of the card.",
};

const WRAP = "mx-auto max-w-[1240px] px-[clamp(16px,4vw,56px)]";
const LINK = "font-semibold text-ink underline decoration-line-strong decoration-1 underline-offset-4 hover:decoration-brand";

function SectionHead({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <div className="mb-10 grid max-w-[62ch] gap-3 sm:mb-12">
      <h2 id={id} className="display text-section">
        {title}
      </h2>
      <p className="text-lg text-ink-muted">{children}</p>
    </div>
  );
}

/**
 * Бал і картка: те, що раніше стояло на головній (картка з двох боків, драбина рівнів,
 * десять позицій, картинки для X). Головна тепер про вакансії; це необов'язкова частина,
 * щоб компанії могли знайти людину. Формули й ваги: /how-scoring-works.
 */
export default function ScoringPage() {
  const face = exampleFace();
  const reasons = builtFrom(EXAMPLE_BACK) ?? "";

  return (
    <>
      <section
        className={`${WRAP} grid items-center gap-12 pt-12 pb-16 sm:pt-16 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:gap-20 lg:pb-20`}
      >
        <div>
          <h1 className="display text-[clamp(3rem,1.5rem+5.4vw,6rem)] leading-[0.88]">Rated on what you shipped.</h1>
          <p className="mt-6 max-w-[40ch] text-xl text-ink-muted">
            Optional, and free. GitHub, X and your wallets become a 0 to 100 score for one of ten crypto roles, with
            the math on the back of the card. Your daily jobs come with or without it.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
            <Button asChild size="lg">
              <Link href="/login">Get started</Link>
            </Button>
            <Link href="/how-scoring-works" className={`inline-flex min-h-11 items-center ${LINK}`}>
              Every formula and weight
            </Link>
          </div>
          <p className="mt-4 max-w-[48ch] text-sm text-ink-muted">
            You start with a short job brief. After it, you can add your sources and create your card.
          </p>
        </div>
        <CardFlip
          className="mx-auto w-full max-w-[380px]"
          front={<CardFront face={face} draw />}
          back={<CardBackFace face={face} back={EXAMPLE_BACK} meta={`Formula ${EXAMPLE_BREAKDOWN.formula}. Example data.`} />}
        />
      </section>

      <section aria-labelledby="ladder-h" className={`${WRAP} pb-20 sm:pb-24`}>
        <div className="grid gap-2 border-t border-line pt-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <h2 id="ladder-h" className="font-sans text-lg font-semibold">
            Every ten points adds a layer to your seal.
          </h2>
          <p className="text-sm text-ink-muted">Four finishes. The seal comes from your card, so no two look alike.</p>
        </div>
        <ol className="mt-6 grid grid-cols-5 gap-x-3 gap-y-6 sm:gap-x-4 lg:grid-cols-10">
          {Array.from({ length: 10 }, (_, i) => {
            const level = i + 1;
            const tier = tierFor(level);
            return (
              <li key={level} className="grid content-start gap-2">
                <MiniCard level={level} seed={face.sealSeed!} value={level} />
                <p className="text-[0.8125rem] leading-tight text-ink-muted">
                  <span className="font-semibold text-ink">{tier.finishName}</span>
                  <br />
                  {levelRange(level)}
                </p>
              </li>
            );
          })}
        </ol>
      </section>

      <section id="positions" aria-labelledby="positions-h" className={`${WRAP} scroll-mt-6 pb-24 sm:pb-28`}>
        <SectionHead id="positions-h" title="Ten positions">
          Pick the one you want to be hired for. Each position reads its own sources, with published weights.
        </SectionHead>
        <ol className="-mx-[clamp(16px,4vw,56px)] flex snap-x snap-mandatory scroll-px-[clamp(16px,4vw,56px)] gap-3 overflow-x-auto px-[clamp(16px,4vw,56px)] pb-3">
          {SCORED_ROLE_KEYS.map((role) => (
            <li
              key={role}
              className="grid w-[168px] shrink-0 snap-start grid-rows-[auto_1fr_auto] gap-3 rounded-[10px] border-2 border-ink bg-surface p-3.5"
            >
              <span className="font-display text-[2.75rem] leading-[0.85] font-black">{POSITION_CODE[role]}</span>
              <span className="self-end text-[0.9375rem] leading-tight font-semibold">{ROLES[role].name}</span>
              <span className="grid gap-1 text-xs leading-snug text-ink-muted">
                <span>{recipeCore(role)}</span>
                <span>Bonus: {recipeBonus(role)}</span>
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-4 text-sm text-ink-muted">
          <Link href="/how-scoring-works" className={LINK}>
            How scoring works
          </Link>
          , with every formula and weight.
        </p>
      </section>

      <section aria-labelledby="share-h" className="bg-sleeve py-24 sm:py-28">
        <div className={WRAP}>
          <SectionHead id="share-h" title="Post your card">
            Two sizes for X. The finish is your level and the seal is yours alone, so people read the card before they
            read the number.
          </SectionHead>
          <div className="grid items-end gap-6 md:grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)]">
            <figure>
              <SharePreview face={face} format="wide" reasons={reasons} />
              <figcaption className="mt-3 text-sm text-ink-muted">
                1200 x 675. The link preview (1200 x 630) keeps the card and the headline.
              </figcaption>
            </figure>
            <figure>
              <SharePreview face={face} format="tall" reasons={reasons} />
              <figcaption className="mt-3 text-sm text-ink-muted">1080 x 1350, portrait.</figcaption>
            </figure>
          </div>
        </div>
      </section>

      <section aria-labelledby="visible-h" className={`${WRAP} py-20 sm:py-24`}>
        <div className="grid max-w-[62ch] gap-3">
          <h2 id="visible-h" className="font-sans text-lg font-semibold">
            You decide who sees it.
          </h2>
          <p className="text-ink-muted">
            Your profile stays hidden until you turn on &quot;Show me to companies&quot; in settings. Companies with access
            then see your scores, roles, level and verification badges, never your wallet addresses, email or handles.
            By default, a company gets your contact only when you accept its intro.
          </p>
        </div>
      </section>
    </>
  );
}
