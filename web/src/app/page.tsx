import { ArrowRight, Check, Send, Wallet } from "lucide-react";
import Link from "next/link";
import type { Metadata } from "next";
import { Suspense } from "react";
import { GithubLogo, XLogo } from "@/components/brand-icons";
import { CardStack } from "@/components/landing/card-stack";
import { exampleFace } from "@/lib/card/example";
import { underprintDataUri } from "@/lib/card/seal";
import { BRIEF_MAX_CHARS } from "@/lib/onboarding/brief-cookie";
import { HomeBoard, HomeBoardShell } from "./home-board";

/**
 * Хто ми, для пошуковика: назва, адреса, знак і акаунт у X. Без цього Google бачить лише текст
 * сторінки й не звязує домен з назвою. GitHub сюди не ставимо (рішення власника 17.09 про
 * відокремлення проєкту від особистого акаунта).
 */
const SITE_LD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://nextcryptojob.xyz/#organization",
      name: "NextCryptoJob",
      url: "https://nextcryptojob.xyz",
      logo: "https://nextcryptojob.xyz/icon.svg",
      description:
        "NextCryptoJob scores a person's public crypto track record on X, GitHub and wallets, and sends matching crypto and web3 jobs every day.",
      sameAs: ["https://x.com/nextcryptojob"],
    },
    {
      "@type": "WebSite",
      "@id": "https://nextcryptojob.xyz/#website",
      name: "NextCryptoJob",
      url: "https://nextcryptojob.xyz",
      inLanguage: "en",
      publisher: { "@id": "https://nextcryptojob.xyz/#organization" },
    },
  ],
};

export const metadata: Metadata = {
  // Назва головної шаблон layout не чіпає (це той самий відрізок шляху), тож назву бренду
  // пишемо тут самі: за словами «next crypto job» шукають і нас, і просто крипто-роботу.
  title: "NextCryptoJob: crypto and web3 jobs by proof of work",
  description:
    "Get hired for what you've actually done. The easy way to find a crypto job: we match you by your X, your wallets and your GitHub, and send up to 5 jobs a day by Telegram or email. Free.",
};

// Живі числа й стрічка з пулу вакансій: сторінку рендеримо на запит, бо статична збірка не бачить
// бази, а ISR цей кеш OpenNext не вміє. Саме табло їде окремо через <Suspense> (./home-board.tsx),
// тож перший байт не чекає на базу.
export const dynamic = "force-dynamic";

const WRAP = "mx-auto max-w-[1280px] px-[clamp(16px,4vw,32px)]";

/** Що ми читаємо: те, що вже показує роботу людини. Лише публічне. X і гаманець обов'язкові (анкета). */
// Раунд 5, п.12: без позначок Required/Optional біля джерел (текст пояснює це в анкеті самій).
const SOURCES = [
  { name: "X", body: "What you post, who replies, and who follows you.", icon: "x" },
  { name: "Wallets", body: "EVM and Solana. How long you've been onchain and what you do there.", icon: "wallet" },
  { name: "GitHub", body: "Repos, stars, and pull requests merged into other projects.", icon: "github" },
] as const;

/**
 * Як це працює, трьома кроками: нова людина мусить зрозуміти з першого екрана, що вона дає і що
 * отримує (рішення власника 18.09). Кожне речення тут правда в коді: X і гаманець обов'язкові,
 * GitHub ні; без CV (FAQ); у кожної вакансії в добірці є причина; добірку можна поставити на паузу
 * в налаштуваннях.
 */
const STEPS = [
  {
    title: "Say what you want",
    body: "Role, field, city or remote, pay. In your own words. No CV and no cover letter.",
  },
  {
    title: "Connect X and a wallet",
    body: "GitHub too, if you have one. We read only public work and build your score card from it.",
  },
  {
    title: "Get up to 5 jobs a day",
    body: "Every day we check the new crypto jobs and send you the 5 that fit best, each with the reason why. Pause any time.",
  },
] as const;

export default function HomePage() {
  const underprint = underprintDataUri("#0e0f12", 1);

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(SITE_LD) }} />
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
            <p className="mt-4 flex flex-wrap gap-x-5 gap-y-1.5 text-[0.9375rem] text-ink-muted">
              <span className="inline-flex items-center gap-1.5">
                <Check aria-hidden className="size-4 text-ink" strokeWidth={2.5} /> Free for candidates
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Send aria-hidden className="size-4 text-ink" strokeWidth={2} /> Up to 5 jobs a day that fit you, by
                Telegram or email
              </span>
            </p>
          </form>
        </div>

        <CardStack faces={[exampleFace(10), exampleFace(6), exampleFace(4), exampleFace(2)]} />
        <div className="ncj-wave" aria-hidden="true" style={{ backgroundImage: `url("${underprint}")` }} />
      </section>

      <section aria-labelledby="how-h" className={`${WRAP} pb-14`}>
        <div className="border-t border-line pt-10 sm:pt-12">
          <p className="ncj-label">How it works</p>
          <h2 id="how-h" className="display mt-4 max-w-[760px] text-section">
            You tell us once. We look for you <span className="ncj-mark">every day</span>.
          </h2>
          <ol className="mt-8 grid overflow-hidden rounded-[28px] border-[1.5px] border-line md:grid-cols-3">
            {STEPS.map((step, i) => (
              <li
                key={step.title}
                className="grid grid-cols-[48px_minmax(0,1fr)] items-start gap-4 p-7 max-md:[&+&]:border-t-[1.5px] md:[&+&]:border-l-[1.5px] [&+&]:border-line"
              >
                <span
                  aria-hidden="true"
                  className="grid size-12 place-items-center rounded-[14px] bg-soft font-display text-xl font-semibold tabular-nums"
                >
                  {i + 1}
                </span>
                <div>
                  <h3 className="font-display text-xl leading-7 font-semibold">{step.title}</h3>
                  <p className="mt-1 text-[0.9375rem] leading-[22px] text-ink-muted">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-5 text-[0.9375rem] text-ink-muted">
            More answers in the{" "}
            <Link href="/faq" className="font-semibold text-ink underline underline-offset-4">
              FAQ
            </Link>
            .
          </p>
        </div>
      </section>

      <section aria-labelledby="board-h" className={`${WRAP} pb-24`}>
        <Suspense fallback={<HomeBoardShell />}>
          <HomeBoard />
        </Suspense>
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
        </div>
      </section>
    </>
  );
}
