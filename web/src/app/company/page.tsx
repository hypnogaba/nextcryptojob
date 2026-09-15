import type { Metadata } from "next";
import Link from "next/link";
import { MiniCard } from "@/components/card/mini-card";
import { Button } from "@/components/ui/button";
import { fnv1a } from "@/lib/card/pattern";

export const metadata: Metadata = {
  title: "For companies",
  description:
    "Onchain proof, not a CV. Search crypto candidates scored from what they have shipped: GitHub, X, onchain history and published work.",
};

const POINTS = [
  {
    title: "Scores built from real work",
    body: "Each candidate is scored for the roles they chose, from GitHub, X, onchain history and published work, with the reasons behind every number.",
  },
  {
    title: "People who are open to offers",
    body: "Candidates are visible unless they hide. You see scores, level, location and pay floor. No names or wallets, and a Telegram handle only if the candidate shares it.",
  },
  {
    title: "Message them directly, or ask first",
    body: "If the candidate shares their Telegram, you see it at once and message them. Otherwise send a short message about the role: if they accept within 14 days, you get their Telegram handle or email.",
  },
  {
    title: "A pipeline for your team and your agents",
    body: "Track candidates from Found to Hired with notes and tags. The same actions work through the REST API and MCP.",
  },
] as const;

// Дошка з прикладом: мітки кандидатів анонімні, як у CRM («#» + 6 знаків id).
const BOARD = [
  { label: "#7A3F1C", level: 8, score: 73, pos: "ENG", note: "GitHub 74.2, merged PRs in other people's repos", stage: "Contact shared", yes: true },
  { label: "#B21E90", level: 9, score: 81, pos: "TRD", note: "Trading 86.0 across 3 chains", stage: "Intro requested", yes: false },
  { label: "#40C7D2", level: 7, score: 68, pos: "SEC", note: "Audit contests 71.5, 4 high findings", stage: "Found", yes: false },
  { label: "#E5098B", level: 8, score: 77, pos: "DRL", note: "GitHub 84.1 and a YouTube channel", stage: "Interview", yes: false },
] as const;

// Приклад: розбір балу одного кандидата (синтетичні дані в стилі демо-компанії з адмінки, для
// статичної маркетингової сторінки без читання бази). Мітка "Example" на самій картці.
const EXAMPLE = {
  label: "#3C9F71",
  role: "Engineer",
  level: 8,
  score: 76,
  sources: [
    { name: "GitHub engineering", weight: "45%", value: 82, note: "312 commits, 61 merged PRs in other people's repos, 12-year history" },
    { name: "X influence", weight: "25%", value: 64, note: "11.4k followers, 3 known builders reply to their posts" },
    { name: "Onchain activity", weight: "20%", value: 71, note: "4 years onchain, active on 3 chains, 640 transactions: DeFi and contract deploys" },
    { name: "Published work", weight: "10%", value: 58, note: "A technical blog, updated in the last 90 days" },
  ],
  contact: "Telegram handle shared directly, visible as soon as the candidate is found",
} as const;

const COMPARISON = [
  { topic: "What you see", cv: "What the candidate chose to write about themselves", ncj: "What they actually shipped: commits, posts, on-chain activity" },
  { topic: "Can it be faked?", cv: "Yes, freely; nothing is checked", ncj: "No: every number traces to a public source you can open yourself" },
  { topic: "Update frequency", cv: "Whenever they remember to edit it", ncj: "Recomputed as their public work changes" },
  { topic: "Role fit", cv: "A list of past titles", ncj: "A 0 to 100 score for the specific role you are hiring, with the reasons" },
  { topic: "Reaching them", cv: "Cold email into an inbox they may not check", ncj: "A message routed to the channel they chose, accepted or declined by them" },
] as const;

const INCLUDED = [
  "Search over every visible candidate, filtered by role, score, level, location and pay floor",
  "The same score breakdown candidates see for themselves, not a summary",
  "Direct contact where the candidate shares it, or a request they accept or decline",
  "Post jobs on NextCryptoJob, seen by candidates matching the role",
  "REST API and MCP for your own tools and agents, same actions as the CRM",
] as const;

const WRAP = "mx-auto max-w-[1240px] px-[clamp(16px,4vw,56px)]";
const LINK = "font-semibold text-ink underline decoration-line-strong decoration-1 underline-offset-4 hover:decoration-brand";

/** Публічна сторінка для компаній (специфікація CRM, 6.1). Статична: сесію не читає. */
export default function CompanyLandingPage() {
  return (
    <>
      <section className={`${WRAP} pt-12 pb-16 sm:pt-16 sm:pb-20`}>
        <p className="ncj-label">Onchain proof, not a CV</p>
        <h1 className="mt-2 display max-w-[16ch] text-[clamp(2.75rem,1.2rem+5vw,6rem)] leading-[0.88]">
          Hire crypto talent by what they have shipped
        </h1>
        <p className="mt-6 max-w-[46ch] text-xl text-ink-muted">
          A candidate&apos;s public work, code, posts and on-chain history, tells you more than any resume, and it
          cannot be faked. We score it for the role you are hiring, so you see the full picture nowhere else shows.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
          <Button asChild size="lg">
            <Link href="/company/start">Create a company</Link>
          </Button>
          <Link href="/company/start?kind=agency" className={`inline-flex min-h-11 items-center ${LINK}`}>
            Recruiting agency? Apply
          </Link>
        </div>
      </section>

      <section aria-label="How it works" className={`${WRAP} pb-16 sm:pb-20`}>
        <ul className="grid gap-x-10 gap-y-8 sm:grid-cols-2">
          {POINTS.map((point) => (
            <li key={point.title} className="grid content-start gap-2 border-t border-line pt-4">
              <h2 className="font-sans text-lg font-semibold text-ink">{point.title}</h2>
              <p className="max-w-[52ch] text-ink-muted">{point.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="example-h" className={`${WRAP} pb-16 sm:pb-20`}>
        <div className="mb-8 grid max-w-[62ch] gap-3">
          <h2 id="example-h" className="display text-section">
            A profile, as a company sees it
          </h2>
          <p className="text-lg text-ink-muted">
            Synthetic data from our demo company, marked Example below. A real profile looks the same shape: a
            score with a breakdown, on-chain facts, X and GitHub, and a way to reach them, only what the candidate
            has made visible. We never show a wallet address, even to a paying company.
          </p>
        </div>
        <div className="grid gap-6 rounded-[10px] border-[1.5px] border-line bg-surface p-6 sm:grid-cols-[auto_minmax(0,1fr)] sm:p-8">
          <div className="flex items-start gap-4 sm:flex-col sm:items-center">
            <MiniCard level={EXAMPLE.level} seed={fnv1a(EXAMPLE.label)} value={EXAMPLE.score} className="w-20" />
            <div className="grid gap-0.5 sm:text-center">
              <span className="ncj-label">Example</span>
              <span className="font-mono text-sm text-ink-muted">{EXAMPLE.label}</span>
              <span className="font-display text-lg font-extrabold text-ink">
                {EXAMPLE.role}, level {EXAMPLE.level}
              </span>
            </div>
          </div>
          <div className="grid gap-5">
            <div className="grid gap-3">
              <h3 className="font-sans text-sm font-semibold text-ink">Score breakdown</h3>
              <ul className="grid gap-2.5">
                {EXAMPLE.sources.map((s) => (
                  <li key={s.name} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 border-t border-line pt-2.5 first:border-t-0 first:pt-0">
                    <span className="text-[0.9375rem] font-semibold text-ink">{s.name}</span>
                    <span className="font-mono text-sm text-ink-muted">
                      {s.value}/100 · {s.weight}
                    </span>
                    <p className="col-span-2 text-sm text-ink-muted">{s.note}</p>
                  </li>
                ))}
              </ul>
            </div>
            <p className="border-t border-line pt-3 text-sm text-ink-muted">
              <span className="font-semibold text-ink">Contact: </span>
              {EXAMPLE.contact}.
            </p>
          </div>
        </div>
      </section>

      <section aria-labelledby="compare-h" className="bg-sleeve py-16 sm:py-20">
        <div className={WRAP}>
          <h2 id="compare-h" className="display text-section">
            CV or LinkedIn, next to NextCryptoJob
          </h2>
          <div className="relative mt-8 overflow-x-auto rounded-[10px] border-[1.5px] border-line bg-surface">
            <table className="w-full min-w-[640px] border-collapse text-left">
              <thead>
                <tr className="font-display text-[0.9375rem] font-extrabold tracking-[0.02em]">
                  <th scope="col" className="border-b-2 border-ink px-5 py-3"></th>
                  <th scope="col" className="border-b-2 border-ink px-5 py-3 text-ink-muted">CV / LinkedIn</th>
                  <th scope="col" className="border-b-2 border-ink px-5 py-3">NextCryptoJob</th>
                </tr>
              </thead>
              <tbody>
                {COMPARISON.map((row) => (
                  <tr key={row.topic} className="border-b border-line last:border-b-0">
                    <th scope="row" className="px-5 py-3 align-top font-sans text-[0.9375rem] font-semibold text-ink">{row.topic}</th>
                    <td className="px-5 py-3 align-top text-[0.9375rem] text-ink-muted">{row.cv}</td>
                    <td className="px-5 py-3 align-top text-[0.9375rem] text-ink">{row.ncj}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section id="scouts" aria-labelledby="scouts-h" className={`${WRAP} scroll-mt-6 pb-16 sm:pb-20`}>
        <div className="mb-8 grid max-w-[62ch] gap-3">
          <h2 id="scouts-h" className="display text-section">
            Scouting board
          </h2>
          <p className="text-lg text-ink-muted">
            Filter by position and level, keep a board, and request an intro. Contact details open only after the
            candidate says yes.
          </p>
        </div>
        {/* relative: sr-only підписи в клітинках інакше тікають з рамки й розширюють сторінку на телефоні. */}
        <div className="relative overflow-x-auto rounded-[10px] border-[1.5px] border-line bg-surface">
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
        <p className="mt-6 max-w-[60ch] text-ink-muted">
          Candidates who hide their profile never appear. You see scores and reasons, never names or wallets.
          100 USDC a month, paid on Solana. Candidates never pay.
        </p>
      </section>

      <section aria-labelledby="pricing" className="bg-sleeve py-16 sm:py-20">
        <div className={`${WRAP} grid gap-8`}>
          <div className="grid gap-4">
            <h2 id="pricing" className="display text-section">
              What 100 USDC a month on Solana includes
            </h2>
            <p className="max-w-[62ch] text-lg text-ink-muted">
              Pay from your own wallet, Solana Pay or any x402 client; we never hold your keys. Or pay per request
              through the API with USDC (x402), no subscription. Recruiting agencies apply first; we review
              applications within 2 business days.
            </p>
          </div>
          <ul className="grid max-w-[62ch] gap-2.5">
            {INCLUDED.map((item) => (
              <li key={item} className="flex gap-3 text-[0.9375rem] text-ink">
                <span aria-hidden="true" className="mt-[3px] size-1.5 shrink-0 rounded-full bg-ink" />
                {item}
              </li>
            ))}
          </ul>
          <p className="max-w-[62ch] text-sm text-ink-muted">
            Hiring only: no resale and no bulk export of candidate data. Read the{" "}
            <Link href="/terms/companies" className={LINK}>
              Company Terms
            </Link>
            .
          </p>
          <div>
            <Button asChild size="lg">
              <Link href="/company/start">Create a company</Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
