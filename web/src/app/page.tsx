import { ArrowRight, Send, Wallet } from "lucide-react";
import type { Metadata } from "next";
import type { CSSProperties } from "react";
import { GithubLogo, XLogo } from "@/components/brand-icons";
import { CardStack } from "@/components/landing/card-stack";
import { JobFeed } from "@/components/landing/job-feed";
import { Odometer } from "@/components/landing/odometer";
import { RollOnView } from "@/components/landing/roll-on-view";
import { exampleFace } from "@/lib/card/example";
import { underprintDataUri } from "@/lib/card/seal";
import { appEnv, db } from "@/lib/db";
import { homeBoard, updatedAgo } from "@/lib/jobs/home-board";
import { roughCount } from "@/lib/jobs/instant";
import { jobsDb } from "@/lib/jobs-db";
import { BRIEF_MAX_CHARS } from "@/lib/onboarding/brief-cookie";

export const metadata: Metadata = {
  description:
    "Get hired for what you've actually done. The easy way to find a crypto job: we match you by your X, your wallets and your GitHub, and send up to 5 jobs a day by Telegram or email. Free.",
};

// Живі числа й стрічка з пулу вакансій: сторінку рендеримо на запит (кеш у пам'яті
// ізолята, lib/jobs/home-board.ts), бо статична збірка не бачить бази, а ISR цей кеш OpenNext не вміє.
export const dynamic = "force-dynamic";

const WRAP = "mx-auto max-w-[1280px] px-[clamp(16px,4vw,32px)]";

/** Скільки рядків у стрічці панелі: сьогоднішні п'ять і далі стрічка. */
const FEED_SIZE = 14;

/** Що ми читаємо: те, що вже показує роботу людини. Лише публічне. X і гаманець обов'язкові (анкета). */
// Раунд 5, п.12: без позначок Required/Optional біля джерел (текст пояснює це в анкеті самій).
const SOURCES = [
  { name: "X", body: "What you post, who replies, and who follows you.", icon: "x" },
  { name: "Wallets", body: "EVM and Solana. How long you've been onchain and what you do there.", icon: "wallet" },
  { name: "GitHub", body: "Repos, stars, and pull requests merged into other projects.", icon: "github" },
] as const;

export default async function HomePage() {
  const now = new Date();
  const board = await homeBoard({ db, env: safeEnv(), jobs: jobsDb, now });
  const feed = board.available ? [...board.today.jobs, ...board.ticker].slice(0, FEED_SIZE) : [];
  const s = board.available ? board.stats : null;
  const ago = s ? updatedAgo(s.updatedMs, now.getTime()) : null;

  const underprint = underprintDataUri("#0e0f12", 1);

  return (
    <>
      <section
        className={`${WRAP} relative grid items-center gap-x-12 gap-y-10 pt-6 pb-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.02fr)] lg:pt-10`}
      >
        <div>
          <h1 className="display max-w-[600px] text-hero">Get hired for what you&apos;ve actually done.</h1>
          <p className="mt-6 max-w-[520px] text-lg text-ink-muted sm:text-xl sm:leading-[30px]">
            The easy way to find a crypto job. We match you by your real achievements:{" "}
            <b className="font-semibold text-ink">your X, your wallets, your GitHub.</b>
          </p>
          <form id="find" action="/start" method="get" className="mt-10 max-w-[540px] scroll-mt-24">
            <label htmlFor="brief" className="mb-2 block text-[0.9375rem] font-semibold">
              What work are you looking for?
            </label>
            <div className="ncj-brief">
              <textarea
                id="brief"
                name="brief"
                rows={2}
                maxLength={BRIEF_MAX_CHARS}
                placeholder="Solidity engineer, DeFi, remote, from $150k"
              />
              <div className="mt-2 flex flex-wrap items-center justify-end gap-3">
                <button
                  type="submit"
                  className="inline-flex h-12 items-center gap-2 rounded-[10px] bg-ink px-5 font-semibold text-white transition-[background-color,transform] duration-300 hover:bg-brand-hover active:scale-[0.98]"
                >
                  Find a job
                  <ArrowRight aria-hidden className="size-4 text-white" strokeWidth={2.5} />
                </button>
              </div>
            </div>
          </form>
        </div>

        <CardStack face={exampleFace(10)} />
        <div className="ncj-wave" aria-hidden="true" style={{ backgroundImage: `url("${underprint}")` }} />
      </section>

      <section aria-labelledby="board-h" className={`${WRAP} pb-24`}>
        <div className="ncj-board">
          <div className="ncj-board-h">
            <h2 id="board-h" className="font-display text-[1.375rem] leading-7 font-bold tracking-[-0.02em] sm:text-[1.875rem] sm:leading-9">
              {s ? (
                <RollOnView className="inline">
                  <Odometer value={roughCount(s.live)} style={{ "--odo-delay": "0ms" } as CSSProperties} /> live jobs
                </RollOnView>
              ) : (
                "Live jobs"
              )}
            </h2>
            {s ? (
              <div className="ncj-chip-row">
                <span className="ncj-chip-pill">
                  {s.sources > 0 ? `${roughCount(s.sources)} sources` : `${roughCount(s.companies)} companies`}
                </span>
                <span className="ncj-chip-pill">
                  <i className="ncj-pulse-dot" aria-hidden="true" />
                  Updated daily
                </span>
                {ago ? <span className="ncj-chip-pill">Last check {ago}</span> : null}
              </div>
            ) : null}
          </div>
          <section id="today" aria-labelledby="board-h" className="ncj-sheet-jobs scroll-mt-24">
            {feed.length > 0 ? (
              <JobFeed jobs={feed} />
            ) : (
              <p className="px-1 pb-4 text-ink-muted">
                Today&apos;s jobs did not load just now. Your brief still works: we show your matches as soon as they load.
              </p>
            )}
          </section>
        </div>
      </section>

      <section aria-labelledby="read-h" className={`${WRAP} pb-24`}>
        <div className="border-t border-line pt-16 sm:pt-[72px]">
          <h2 id="read-h" className="display max-w-[760px] text-section">
            We read the work you&apos;ve <span className="ncj-mark">already done</span>, and find jobs that fit it.
          </h2>
          <ul className="mt-12 grid overflow-hidden rounded-[28px] border-[1.5px] border-line md:grid-cols-3">
            {SOURCES.map((src) => (
              <li
                key={src.name}
                className="grid grid-cols-[48px_minmax(0,1fr)] items-start gap-4 p-7 max-md:[&+&]:border-t-[1.5px] md:[&+&]:border-l-[1.5px] [&+&]:border-line"
              >
                <span aria-hidden="true" className="grid size-12 place-items-center rounded-[14px] bg-soft">
                  {src.icon === "x" ? (
                    <XLogo className="size-6" />
                  ) : src.icon === "wallet" ? (
                    <Wallet className="size-6" strokeWidth={2} />
                  ) : (
                    <GithubLogo className="size-6" />
                  )}
                </span>
                <div>
                  <h3 className="font-display text-xl leading-7 font-semibold">{src.name}</h3>
                  <p className="mt-1 text-[0.9375rem] leading-[22px] text-ink-muted">{src.body}</p>
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-8 flex flex-wrap items-center gap-4 text-lg leading-7">
            <span className="inline-flex items-center gap-2">
              <Send aria-hidden className="size-5" strokeWidth={2} /> Up to 5 matching jobs a day, by Telegram or email.
            </span>
          </div>
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
