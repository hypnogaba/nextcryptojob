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
import { levelRange, tierFor } from "@/lib/card/tiers";
import { fnv1a } from "@/lib/card/pattern";
import { ROLES } from "@/lib/card/roles";
import { POSITION_CODE, recipeBonus, recipeCore, SCORED_ROLE_KEYS } from "@/lib/roles/recipes";

export const metadata: Metadata = {
  description:
    "Rated on what you shipped. GitHub, X and your wallets become a 0 to 100 score for one of ten crypto roles, with the math on the back of the card.",
};

const WRAP = "mx-auto max-w-[1240px] px-[clamp(16px,4vw,56px)]";

// Дошка з прикладом: мітки кандидатів анонімні, як у CRM («#» + 6 знаків id).
const BOARD = [
  { label: "#7A3F1C", level: 8, score: 73, pos: "ENG", note: "GitHub 74.2, merged PRs in other people's repos", stage: "Contact shared", yes: true },
  { label: "#B21E90", level: 9, score: 81, pos: "TRD", note: "Trading 86.0 across 3 chains", stage: "Intro requested", yes: false },
  { label: "#40C7D2", level: 7, score: 68, pos: "SEC", note: "Audit contests 71.5, 4 high findings", stage: "Found", yes: false },
  { label: "#E5098B", level: 8, score: 77, pos: "DRL", note: "GitHub 84.1 and a YouTube channel", stage: "Interview", yes: false },
] as const;

// Справжній запит API (docs/api/openapi.yaml): пошук кандидатів, x402 для гостя.
const AGENT_LOG: readonly (readonly [string, string])[] = [
  ["POST", "/api/v1/candidates/search"],
  ["", '{"filters":{"role":"trader","min_level":8}}'],
  ["402", "Payment Required, x402: $0.50 USDC"],
  ["POST", "same body + PAYMENT-SIGNATURE"],
  ["200", '{"data":[{"label":"#B21E90","headline":{"role":"trader","score":81,"level":9}}]}'],
];

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

export default function HomePage() {
  const face = exampleFace();
  const reasons = builtFrom(EXAMPLE_BACK) ?? "";

  return (
    <>
      <section className={`${WRAP} grid items-center gap-12 pt-12 pb-16 sm:pt-16 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:gap-20 lg:pb-20`}>
        <div>
          <h1 className="display text-hero">Rated on what you shipped.</h1>
          <p className="mt-6 max-w-[34ch] text-xl text-ink-muted">
            GitHub, X and your wallets become a 0 to 100 score for one of ten crypto roles, with the math on the back
            of the card. Then we send you a few jobs that fit, every day.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
            <Button asChild size="lg">
              <Link href="/login">Get my card</Link>
            </Button>
            <Link
              href="#positions"
              className="inline-flex min-h-11 items-center font-semibold text-ink underline decoration-line-strong decoration-1 underline-offset-4 hover:decoration-brand"
            >
              See the ten positions
            </Link>
          </div>
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
          <Link href="/how-scoring-works" className="font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand">
            How scoring works
          </Link>
          , with every formula and weight.
        </p>
      </section>

      <section aria-labelledby="share-h" className="bg-sleeve py-24 sm:py-28">
        <div className={WRAP}>
          <SectionHead id="share-h" title="Post your card">
            Two sizes for X. The finish is your level and the seal is yours alone, so people read the card before
            they read the number.
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

      <section id="scouts" aria-labelledby="scouts-h" className={`${WRAP} py-24 sm:py-28`}>
        <SectionHead id="scouts-h" title="Scouting board">
          For companies. Filter by position and level, keep a board, and request an intro. Contact details open only
          after the candidate says yes.
        </SectionHead>
        <div className="overflow-x-auto rounded-[10px] border-2 border-ink bg-surface">
          <table className="w-full min-w-[720px] border-collapse text-left">
            <caption className="px-5 pt-4 text-left text-sm text-ink-muted">Board: Solana infra team. Example data.</caption>
            <thead>
              <tr className="font-display text-[0.9375rem] font-extrabold tracking-[0.02em]">
                <th scope="col" className="border-b-2 border-ink px-5 py-3">Card</th>
                <th scope="col" className="border-b-2 border-ink px-5 py-3">Candidate</th>
                <th scope="col" className="border-b-2 border-ink px-5 py-3">Pos</th>
                <th scope="col" className="border-b-2 border-ink px-5 py-3">Scout note</th>
                <th scope="col" className="border-b-2 border-ink px-5 py-3">Stage</th>
              </tr>
            </thead>
            <tbody>
              {BOARD.map((row) => (
                <tr key={row.label} className="border-b border-line last:border-b-0 hover:bg-brand-soft">
                  <td className="px-5 py-3">
                    <MiniCard level={row.level} seed={fnv1a(row.label)} value={row.score} className="w-11" />
                    <span className="sr-only">
                      Score {row.score}, level {row.level}
                    </span>
                  </td>
                  <td className="px-5 py-3 font-mono text-sm">{row.label}</td>
                  <td className="px-5 py-3 font-display text-[1.375rem] font-black">{row.pos}</td>
                  <td className="px-5 py-3 text-[0.9375rem] text-ink-muted">{row.note}</td>
                  <td className={`px-5 py-3 font-semibold ${row.yes ? "text-brand" : ""}`}>{row.stage}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
          <p className="max-w-[60ch] text-ink-muted">
            Candidates stay hidden until they turn visibility on. You see scores and reasons, never names or wallets.
            Company plan: $100 a month. Candidates never pay.
          </p>
          <Button asChild size="lg">
            <Link href="/company">Open the board</Link>
          </Button>
        </div>
      </section>

      <section id="agents" aria-labelledby="agents-h" className={`${WRAP} scroll-mt-6 pb-24 sm:pb-28`}>
        <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:gap-12">
          <SectionHead id="agents-h" title="Agents scout too">
            REST and MCP, the same cards. An agent without a key pays per search in USDC on Base or Solana with x402.
          </SectionHead>
          <pre className="overflow-x-auto rounded-[10px] border-2 border-ink bg-surface p-5 font-mono text-sm leading-relaxed">
            {AGENT_LOG.map(([verb, rest]) => (
              <span key={rest} className="block">
                <span className="text-ink-muted">{verb.padEnd(5)}</span>
                {rest}
              </span>
            ))}
          </pre>
        </div>
      </section>
    </>
  );
}
