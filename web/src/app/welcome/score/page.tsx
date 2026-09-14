import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CardFront } from "@/components/card/card-front";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { ROLES } from "@/lib/card/roles";
import { cardPath, xShareUrl } from "@/lib/card/share";
import { getCard, getCardEvidence, listActiveCards } from "@/lib/card/store";
import { cardView } from "@/lib/card/view";
import { db } from "@/lib/db";
import { listIdentities } from "@/lib/identity/store";
import { briefDone } from "@/lib/onboarding/steps";
import { loadAnswers } from "@/lib/onboarding/store";
import { explainRole, sourceState } from "@/lib/score/explain";
import { loadScores } from "@/lib/score/load";
import { improvements, nextPollStep, rankRoles } from "@/lib/score/result";
import { profileStatus } from "@/lib/score/status";
import { requestOrigin } from "../../c/[slug]/card-data";
import { RescoreButton } from "../../profile/rescore-button";
import { IssueCard } from "./issue-card";
import { ScoringWait } from "./scoring-wait";

export const metadata: Metadata = { title: "Your score", robots: { index: false } };

const LINK = "font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand";

/**
 * Одразу після кроків балу: «Scoring your work…», поки рушій рахує, далі бал, рівень і картка з
 * «Download image» і «Share on X». Сторінка лише читає: чергу й картку ставлять дії з браузера.
 */
export default async function ScorePage() {
  const user = await requireUser();
  const d = db();
  const [answers, identities, status] = await Promise.all([
    loadAnswers(d, user.id),
    listIdentities(d, user.id),
    profileStatus(d, user.id),
  ]);
  if (!briefDone(answers.step)) redirect("/welcome");
  // X обов'язковий (власник 13.09): без нього бал не рахуємо, спершу крок X.
  if (!identities.some((i) => i.kind === "x")) redirect("/welcome?step=x");

  const step = nextPollStep(status);
  const shell = (children: React.ReactNode) => (
    <section className="mx-auto grid max-w-3xl gap-8 px-[clamp(16px,4vw,56px)] pt-8 pb-20 sm:pt-14">
      <h1 className="display text-title">Your score</h1>
      {children}
    </section>
  );

  if (step === "wait" || step === "enqueue") {
    return shell(<ScoringWait key={`${status.job?.status ?? "none"}:${status.sourcesChanged}`} initial={status} />);
  }

  if (step === "failed") {
    return shell(
      <div role="alert" className="grid gap-3 rounded-xl border border-destructive/50 bg-surface p-5 sm:p-6">
        <p className="font-medium text-ink">We could not finish reading your sources.</p>
        <p className="text-sm text-ink-muted">A source did not answer in time. Nothing is wrong with your profile.</p>
        <div className="w-fit">
          <RescoreButton label="Try again" />
        </div>
      </div>,
    );
  }

  const scores = await loadScores(d, user.id);
  const ranked = rankRoles(answers.roles, scores);
  const better = improvements(identities);
  const improve =
    better.length > 0 ? (
      <section aria-labelledby="improve-h" className="grid gap-3 rounded-xl border border-line bg-surface p-5 sm:p-6">
        <h2 id="improve-h" className="font-sans text-lg font-semibold text-ink">
          Improve your score
        </h2>
        <p className="text-sm text-ink-muted">
          More data gives a better score: up to 10 wallets and one X account, plus GitHub, YouTube and a website.
        </p>
        <ul className="grid gap-2">
          {better.map((b) => (
            <li key={b.key} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-line pt-2">
              <span className="text-sm text-ink">{b.text}</span>
              <Link href={b.href} className={`text-sm ${LINK}`}>
                Add
              </Link>
            </li>
          ))}
        </ul>
      </section>
    ) : null;
  const next = (
    <div className="flex flex-wrap gap-x-6 gap-y-2">
      <Link href="/profile" className={`inline-flex min-h-11 items-center ${LINK}`}>
        Your card and full breakdown
      </Link>
      <Link href="/jobs" className={`inline-flex min-h-11 items-center ${LINK}`}>
        See your jobs
      </Link>
    </div>
  );

  const best = ranked[0];
  if (!best) {
    const state = sourceState(identities);
    const views = answers.roles.map((role) => explainRole(role, scores.get(role) ?? null, state));
    return shell(
      <>
        <div className="grid gap-3 rounded-xl border border-line bg-surface p-5 sm:p-6">
          <p className="font-medium text-ink">We could not score your roles yet.</p>
          <ul className="grid gap-2 text-sm text-ink-muted">
            {views.map((v) => (
              <li key={v.role}>
                <span className="font-semibold text-ink">{v.name}:</span>{" "}
                {v.state === "missing" ? v.reason : v.state === "unscored" ? `${v.note}.` : "Waiting for your score."}
              </li>
            ))}
          </ul>
        </div>
        {improve}
        {next}
      </>,
    );
  }

  const cards = await listActiveCards(d, user.id);
  const active = cards.find((c) => c.role === best.role) ?? null;
  const others = ranked.slice(1);
  const summary = (
    <div className="grid gap-2">
      <p className="text-lg text-ink">
        We scored you <span className="font-display text-3xl font-extrabold">{best.score}</span> {ROLES[best.role].as}, level{" "}
        {best.level} of 10.
      </p>
      <p className="text-sm text-ink-muted">
        An honest score from your past public work: your X, your wallets and the other sources you added. It updates when
        you add more.
      </p>
      {others.length > 0 ? (
        <p className="text-sm text-ink-muted">
          Your other roles: {others.map((o) => `${ROLES[o.role].name} ${o.score}`).join(", ")}.
        </p>
      ) : null}
    </div>
  );

  if (!active) {
    return shell(
      <>
        {summary}
        <IssueCard role={best.role} />
        {improve}
        {next}
      </>,
    );
  }

  const [card, evidence, origin] = await Promise.all([getCard(d, active.slug), getCardEvidence(d, active.slug), requestOrigin()]);
  if (!card) redirect("/profile");
  const view = cardView(card, evidence);
  const stale = view.score !== best.score;
  return shell(
    <>
      {summary}
      <div className="grid items-start gap-8 md:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        <div className="ncj-card mx-auto w-full max-w-[340px]">
          <CardFront face={view} draw />
        </div>
        <div className="grid content-start gap-4">
          <p className="text-ink">
            This is your card. It is public at its own link, so you can share it with friends and on X. It shows your name,
            role and score, never your wallets or links.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button asChild size="lg">
              <a href={`${cardPath(active.slug)}/share/tall`} download>
                Download image
              </a>
            </Button>
            <Button asChild size="lg" variant="outline">
              <a href={xShareUrl(view, origin)} target="_blank" rel="noopener noreferrer">
                Share on X
              </a>
            </Button>
          </div>
          <p className="text-sm text-ink-muted">
            <Link href={cardPath(active.slug)} className={LINK}>
              Open your public card
            </Link>{" "}
            or get the{" "}
            <a href={`${cardPath(active.slug)}/share/wide`} download className={LINK}>
              16:9 image
            </a>
            . The name on it is {view.displayName}; you can change it on your profile.
          </p>
          {stale ? (
            <div className="grid gap-2 border-t border-line pt-4">
              <p className="text-sm text-ink">
                Your card shows {view.score}. Your score is now {best.score}.
              </p>
              <IssueCard role={best.role} auto={false} label={`Make a new card with ${best.score}`} />
            </div>
          ) : null}
        </div>
      </div>
      {improve}
      {next}
    </>,
  );
}
