import { Check, ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { MiniCard } from "@/components/card/mini-card";
import { LiveBoard } from "@/components/landing/live-board";
import { TodaysJobs } from "@/components/landing/todays-jobs";
import { Button } from "@/components/ui/button";
import { exampleFace } from "@/lib/card/example";
import { appEnv, db } from "@/lib/db";
import { homeBoard } from "@/lib/jobs/home-board";
import { roughCount } from "@/lib/jobs/instant";
import { jobsDb } from "@/lib/jobs-db";

export const metadata: Metadata = {
  description:
    "Crypto jobs matched to what you've done. No CV, no motivation letter: add your X and wallets and get up to 5 jobs a day by email or Telegram. Free.",
};

// Живі числа, приклад листа й стрічка з пулу вакансій: сторінку рендеримо на запит (кеш у пам'яті
// ізолята, lib/jobs/home-board.ts), бо статична збірка не бачить бази, а ISR цей кеш OpenNext не вміє.
export const dynamic = "force-dynamic";

const WRAP = "mx-auto max-w-[1240px] px-[clamp(16px,4vw,56px)]";
const LINK =
  "font-semibold text-ink underline decoration-line-strong decoration-1 underline-offset-4 hover:decoration-brand";

/** Анкета коротко, як ланцюжок, у тому самому порядку, що /welcome: бриф (слова, де, зарплата), ролі, X, гаманці. */
const BRIEF = ["Brief", "Roles", "X", "Wallets", "Done"] as const;

/** Що ми читаємо: те, що вже показує роботу людини. Лише публічне. */
const SOURCES = [
  { name: "X", note: null, body: "What you post, how people respond, and who follows you." },
  {
    name: "Wallets",
    note: "EVM and Solana",
    body: "How long you have been onchain and what you do there: transactions, swaps, the chains you use.",
  },
  { name: "GitHub", note: null, body: "What you build: your repos, their stars, and pull requests merged into other projects." },
  { name: "YouTube", note: null, body: "What you explain on camera, how often you post, and who watches." },
  { name: "Your site", note: null, body: "What you write and publish, and how recent it is." },
] as const;

export default async function HomePage() {
  const now = new Date();
  const board = await homeBoard({ db, env: safeEnv(), jobs: jobsDb, now });
  const face = exampleFace();
  // «Mon 14 Sep»: коротко, щоб рядок листа на телефоні не переносився.
  const part = (o: Intl.DateTimeFormatOptions) => now.toLocaleDateString("en-US", { ...o, timeZone: "UTC" });
  const date = `${part({ weekday: "short" })} ${part({ day: "numeric" })} ${part({ month: "short" })}`;
  const sources = board.available && board.stats.sources > 0 ? roughCount(board.stats.sources) : null;

  return (
    <>
      <section
        className={`${WRAP} grid items-center gap-x-16 gap-y-10 pt-8 pb-12 sm:pt-14 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:pt-16 lg:pb-16`}
      >
        <div>
          <h1 className="display max-w-[14ch] text-[clamp(2.75rem,1.7rem+3.9vw,5rem)] leading-[0.9]">
            Crypto jobs matched to what you&apos;ve done.
          </h1>
          <p className="mt-5 max-w-[42ch] text-lg text-ink-muted sm:mt-6 sm:text-xl">
            No CV, no motivation letter. Add your X and wallets, and get jobs that fit you, up to 5 a day, by email or
            Telegram.
          </p>
          <ol aria-label="The brief, about 5 clicks" className="mt-6 flex flex-wrap items-center gap-y-2">
            {BRIEF.map((step, i) => {
              const done = i === BRIEF.length - 1;
              return (
                <li key={step} className="flex items-center">
                  <span
                    className={
                      done
                        ? "inline-flex h-8 items-center gap-0.5 rounded-full bg-brand-soft px-2 text-[0.8125rem] font-semibold text-brand sm:px-3 sm:text-[0.9375rem]"
                        : "inline-flex h-8 items-center rounded-full border border-line bg-surface px-2 text-[0.8125rem] font-medium text-ink sm:px-3 sm:text-[0.9375rem]"
                    }
                  >
                    {done ? <Check aria-hidden className="size-3.5 sm:size-4" strokeWidth={2.5} /> : null}
                    {step}
                  </span>
                  {done ? null : (
                    <ChevronRight aria-hidden className="size-3.5 text-line-strong sm:mx-1 sm:size-4" strokeWidth={2} />
                  )}
                </li>
              );
            })}
          </ol>
          <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3 sm:mt-8">
            <Button asChild size="lg" className="h-12 w-full px-6 text-[1.0625rem] sm:w-auto">
              <Link href="/login">Get my jobs</Link>
            </Button>
            <p className="text-sm text-ink-muted">Free. About 5 clicks.</p>
          </div>
        </div>
        <div className="w-full lg:max-w-[520px] lg:justify-self-end">
          <TodaysJobs today={board.today} date={date} />
        </div>
      </section>

      {board.available ? <LiveBoard board={board} now={now.getTime()} /> : null}

      <section aria-labelledby="look-h" className={`${WRAP} py-16 sm:py-24`}>
        <div className="grid gap-x-16 gap-y-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)] lg:items-start">
          <div>
            <h2 id="look-h" className="display text-title">
              What we look at
            </h2>
            <p className="mt-4 max-w-[52ch] text-lg text-ink-muted">
              No motivation letter. Link the accounts that show your work, and we match jobs to it.
            </p>
            <dl className="mt-8 border-b border-line">
              {SOURCES.map((s) => (
                <div key={s.name} className="grid gap-1 border-t border-line py-4 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-6">
                  <dt className="flex flex-wrap items-baseline gap-x-2 gap-y-1 sm:grid sm:content-start">
                    <span className="font-display text-[1.625rem] leading-none font-extrabold uppercase">{s.name}</span>
                    {s.note ? <span className="text-[0.8125rem] text-ink-muted">{s.note}</span> : null}
                  </dt>
                  <dd className="max-w-[56ch] text-ink-muted sm:pt-0.5">{s.body}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-4 text-sm text-ink-muted">
              We read public data only. Your wallet addresses never go on your card.
            </p>
          </div>

          <aside
            aria-labelledby="card-h"
            className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-5 rounded-xl border border-line bg-surface p-5 lg:mt-3 lg:grid-cols-1 lg:justify-items-start lg:p-6"
          >
            <MiniCard
              level={face.level}
              seed={face.sealSeed!}
              value={face.score}
              spin
              className="w-full lg:w-[152px]"
            />
            <div className="grid gap-2">
              <h3 id="card-h" className="font-sans text-lg leading-tight font-semibold">
                Your card
              </h3>
              <p className="text-[0.9375rem] text-ink-muted">
                What you link also makes a card: a 0 to 100 score for your role, with a seal no one else has. Post it
                on X if you like.
              </p>
              <Link href="/scoring" className={`inline-flex min-h-11 items-center ${LINK}`}>
                See how the card works
              </Link>
            </div>
          </aside>
        </div>
      </section>

      <section aria-labelledby="daily-h" className="bg-sleeve py-16 sm:py-20">
        <div className={`${WRAP} grid gap-x-16 gap-y-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end`}>
          <div>
            <h2 id="daily-h" className="display text-title">
              New jobs every day
            </h2>
            <p className="mt-4 max-w-[56ch] text-lg text-ink-muted">
              {sources
                ? `Every day we scan ${sources} crypto job sources, from company career pages to job boards.`
                : "Every day we scan crypto company career pages and job boards."}{" "}
              You get up to 5 new jobs that fit you, by email or Telegram, at the hour you pick. Pause any time.
            </p>
          </div>
          <Button asChild size="lg" className="h-12 w-full px-6 text-[1.0625rem] sm:w-auto">
            <Link href="/login">Get my jobs</Link>
          </Button>
        </div>
      </section>
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
