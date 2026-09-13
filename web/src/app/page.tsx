import type { Metadata } from "next";
import Link from "next/link";
import { CardBackFace } from "@/components/card/card-back";
import { CardFlip } from "@/components/card/card-flip";
import { CardFront } from "@/components/card/card-front";
import { MiniCard } from "@/components/card/mini-card";
import { LiveBoard } from "@/components/landing/live-board";
import { Button } from "@/components/ui/button";
import { EXAMPLE_BACK, EXAMPLE_BREAKDOWN, exampleFace } from "@/lib/card/example";
import { FINISHES } from "@/lib/card/tiers";
import { appEnv, db } from "@/lib/db";
import { homeBoard } from "@/lib/jobs/home-board";
import { jobsDb } from "@/lib/jobs-db";

export const metadata: Metadata = {
  description:
    "Answer a short brief and get a few crypto jobs that fit you, right away and every day by Telegram or email. Free.",
};

// Живі числа й стрічка з пулу вакансій: сторінку рендеримо на запит (кеш у пам'яті ізолята,
// lib/jobs/home-board.ts), бо статична збірка не бачить бази, а ISR цей кеш OpenNext не вміє.
export const dynamic = "force-dynamic";

const WRAP = "mx-auto max-w-[1240px] px-[clamp(16px,4vw,56px)]";
const LINK =
  "font-semibold text-ink underline decoration-line-strong decoration-1 underline-offset-4 hover:decoration-brand";

const STEPS = [
  {
    title: "Tell us what you want",
    body: "Your roles, remote or a city, the lowest salary you would take, and a few words of your own. About 2 minutes.",
  },
  {
    title: "We match you",
    body: "You see the jobs that fit right away, one per company, with a line on why each one matches.",
  },
  {
    title: "Get a few jobs every day",
    body: "Up to 5 new jobs a day by Telegram or email, at the hour you pick. Pause any time.",
  },
] as const;

const ON_CARD = [
  {
    title: "A score for your role",
    body: "0 to 100 for one of ten crypto roles, from GitHub, X and your wallets. The math is on the back.",
  },
  {
    title: "A level and a finish",
    body: "Every ten points is a level. The card goes from paper to chrome to black, and level 10 gets the red seal.",
  },
  {
    title: "A seal that is yours",
    body: "One layer per level, drawn from your card, so no two look alike.",
  },
] as const;

export default async function HomePage() {
  const now = new Date();
  const board = await homeBoard({ db, env: safeEnv(), jobs: jobsDb, now });
  const face = exampleFace();

  return (
    <>
      <section
        className={`${WRAP} grid items-center gap-x-16 gap-y-10 pt-8 pb-12 sm:pt-14 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:pb-16`}
      >
        <div>
          <h1 className="display text-[clamp(3rem,1.6rem+5vw,6rem)] leading-[0.88]">Crypto jobs that fit you.</h1>
          <p className="mt-5 max-w-[40ch] text-lg text-ink-muted sm:mt-6 sm:text-xl">
            Answer a short brief and get a few matching jobs every day. Add GitHub, X or a wallet and you also get a
            card that scores your work for that role.
          </p>
          <div className="mt-7 grid justify-items-start gap-3 sm:mt-8">
            <Button asChild size="lg" className="h-12 px-6 text-[1.0625rem]">
              <Link href="/login">Get my jobs</Link>
            </Button>
            <p className="text-sm text-ink-muted">Free. About 2 minutes. Jobs by Telegram or email.</p>
          </div>
        </div>
        <figure className="mx-auto grid w-full max-w-[250px] justify-items-center gap-1 sm:max-w-[320px] lg:max-w-[350px]">
          <CardFlip
            className="w-full"
            front={<CardFront face={face} draw />}
            back={<CardBackFace face={face} back={EXAMPLE_BACK} meta={`Formula ${EXAMPLE_BREAKDOWN.formula}. Example data.`} />}
            frontLabel="See how the score adds up"
          />
          <figcaption className="max-w-[34ch] text-center text-sm text-ink-muted">
            What you get: a 0 to 100 score for your role, and jobs for that role every day.
          </figcaption>
        </figure>
      </section>

      <LiveBoard board={board} now={now.getTime()} />

      <section aria-labelledby="how-h" className={`${WRAP} py-16 sm:py-24`}>
        <h2 id="how-h" className="display text-section">
          How it works
        </h2>
        <ol className="mt-10 grid gap-x-10 gap-y-10 md:grid-cols-3">
          {STEPS.map((step, i) => (
            <li key={step.title} className="grid content-start gap-3 border-t-2 border-ink pt-4">
              <span aria-hidden className="font-display text-[4rem] leading-[0.8] font-black">
                {i + 1}
              </span>
              <h3 className="font-sans text-lg font-semibold text-ink">{step.title}</h3>
              <p className="max-w-[40ch] text-ink-muted">{step.body}</p>
            </li>
          ))}
        </ol>
        <div className="mt-12">
          <Button asChild size="lg" className="h-12 px-6 text-[1.0625rem]">
            <Link href="/login">Get my jobs</Link>
          </Button>
        </div>
      </section>

      <section aria-labelledby="card-h" className="bg-sleeve py-16 sm:py-20">
        <div className={`${WRAP} grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16`}>
          <div>
            <h2 id="card-h" className="display text-title">
              What&apos;s on your card
            </h2>
            <dl className="mt-8 grid gap-5">
              {ON_CARD.map((item) => (
                <div key={item.title} className="grid gap-1 border-t border-line pt-3">
                  <dt className="font-semibold text-ink">{item.title}</dt>
                  <dd className="max-w-[52ch] text-ink-muted">{item.body}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-6 max-w-[52ch] text-sm text-ink-muted">
              Optional. Companies see your card only if you turn that on.
            </p>
            <p className="mt-1">
              <Link href="/scoring" className={`inline-flex min-h-11 items-center ${LINK}`}>
                How scoring works
              </Link>
            </p>
          </div>
          <ol className="grid grid-cols-4 gap-3 sm:gap-5" aria-label="The four finishes">
            {FINISHES.map((f) => (
              <li key={f.finish} className="grid content-start gap-2">
                <MiniCard level={f.sample} seed={face.sealSeed!} value={f.sample} />
                <p className="text-[0.8125rem] leading-tight text-ink-muted">
                  <span className="font-semibold text-ink">{f.name}</span>
                  <br />
                  {f.levels}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <div className={`${WRAP} pt-10 pb-4`}>
        <p className="flex flex-wrap gap-x-8 gap-y-1 text-ink-muted">
          <span>
            Hiring?{" "}
            <Link href="/company" className={`inline-flex min-h-11 items-center ${LINK}`}>
              Search scored candidates
            </Link>
          </span>
          <span>
            Building an agent?{" "}
            <Link href="/agents" className={`inline-flex min-h-11 items-center ${LINK}`}>
              Use the API and MCP
            </Link>
          </span>
        </p>
      </div>
    </>
  );
}

/** SITE_URL для посилань на вакансії компаній; без оточення Worker порожньо (посилання відносні). */
function safeEnv(): { SITE_URL?: string } {
  try {
    return { SITE_URL: appEnv().SITE_URL };
  } catch {
    return {};
  }
}
