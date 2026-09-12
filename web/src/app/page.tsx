import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SampleScoreCard } from "@/components/sample-score-card";

const POINTS = [
  {
    title: "A score for the role you want",
    body: "Built from your X, GitHub and wallets, with the reasons behind every number.",
  },
  {
    title: "Fresh crypto jobs every day",
    body: "A short list that fits your role, place and pay, by email or Telegram.",
  },
  {
    title: "Companies reach you only if you switch it on",
    body: "You stay hidden by default. Turn on visibility when you want to be found.",
  },
] as const;

export default function HomePage() {
  return (
    <>
      <section className="mx-auto grid max-w-5xl gap-12 px-4 pt-16 pb-12 sm:px-6 sm:pt-24 lg:grid-cols-[1.35fr_1fr] lg:items-center lg:gap-16">
        <div>
          <h1 className="text-3xl leading-tight font-semibold tracking-tight sm:text-5xl sm:leading-[1.1]">
            Your onchain and social track record, turned into your next crypto job.
          </h1>
          <p className="mt-6 max-w-xl text-lg text-ink-muted">
            Connect X, GitHub and your wallets, see how you score for the role you want, and get matched to jobs that fit.
          </p>
          <Button asChild size="lg" className="mt-8 h-11 px-5 text-base">
            <Link href="/login">Get your score</Link>
          </Button>
        </div>
        <SampleScoreCard />
      </section>

      <section aria-label="How it works" className="mx-auto max-w-5xl px-4 pb-20 sm:px-6 sm:pb-28">
        <ol className="grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3">
          {POINTS.map((point, i) => (
            <li key={point.title} className="bg-surface p-5 sm:p-6">
              <span className="font-mono text-xs text-brand">0{i + 1}</span>
              <h2 className="mt-3 font-sans text-base font-semibold text-ink">{point.title}</h2>
              <p className="mt-2 text-sm text-ink-muted">{point.body}</p>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
