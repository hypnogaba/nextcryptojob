import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { suggestDisplayName } from "@/lib/card/display-name";
import { cardEligibility } from "@/lib/card/eligibility";
import { hasConsent, SCORING_CONSENT } from "@/lib/consent";
import { db } from "@/lib/db";
import { listIdentities } from "@/lib/identity/store";
import { loadAnswers } from "@/lib/onboarding/store";
import { cardBack } from "@/lib/card/back";
import { sealSeed } from "@/lib/card/seal";
import { listActiveCards } from "@/lib/card/store";
import { explainRole, sourceState, type Breakdown } from "@/lib/score/explain";
import { loadScores } from "@/lib/score/load";
import { isActive, profileStatus } from "@/lib/score/status";
import { parseWait } from "../welcome/flow";
import { RescoreButton } from "./rescore-button";
import { RoleCard } from "./role-card";
import { SourcesPanel } from "./sources-panel";
import { StatusPanel } from "./status-panel";
import { VerifyPrompt } from "./verify-prompt";

export const metadata: Metadata = { title: "Your profile", robots: { index: false } };

type Props = { searchParams: Promise<{ wait?: string | string[] }> };

function reasonOf(json: string | undefined): string | null {
  try {
    const reason = (JSON.parse(json ?? "{}") as Breakdown).reason;
    return typeof reason === "string" ? reason : null;
  } catch {
    return null;
  }
}

/** Сторінка балу: ролі людини, бал кожної з поясненням, стан черги, джерела. */
export default async function ProfilePage({ searchParams }: Props) {
  const user = await requireUser();
  const d = db();
  const [answers, identities, status, scores, consent, cards] = await Promise.all([
    loadAnswers(d, user.id),
    listIdentities(d, user.id),
    profileStatus(d, user.id),
    loadScores(d, user.id),
    hasConsent(d, user.id, SCORING_CONSENT.kind),
    listActiveCards(d, user.id),
  ]);
  const done = answers.step === "done";
  const state = sourceState(identities);
  const x = identities.find((i) => i.kind === "x") ?? null;
  const github = identities.find((i) => i.kind === "github") ?? null;
  const verified = { x: Boolean(x?.verifiedAt), github: Boolean(github?.verifiedAt) };
  const defaultName = suggestDisplayName(verified.x ? x!.value : null, user.email);
  const active = isActive(status);
  const wait = parseWait((await searchParams).wait);
  const changed = done && consent && status.sourcesChanged && !active;
  // Печатка з підтвердженого гаманця, інакше зі slug картки (підпису гаманців у релізі 1 ще немає).
  const wallet = identities.find((i) => (i.kind === "evm" || i.kind === "solana") && i.verifiedAt)?.value ?? null;

  return (
    <section className="mx-auto grid max-w-4xl gap-6 px-[clamp(16px,4vw,56px)] pt-8 pb-20 sm:pt-14">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="display text-title">Your score</h1>
        {done ? (
          <Link
            href="/welcome"
            className="-mr-2 inline-flex min-h-11 items-center px-2 text-sm font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand"
          >
            Edit answers
          </Link>
        ) : null}
      </div>

      {!done ? (
        <div className="grid gap-3 rounded-xl border border-line bg-surface p-4 sm:p-5">
          <p className="text-ink">Finish setting up your profile to get your score.</p>
          <Button asChild size="lg" className="w-fit">
            <Link href="/welcome">Continue setup</Link>
          </Button>
        </div>
      ) : (
        <StatusPanel key={`${status.job?.status ?? "none"}:${status.scored}`} initial={status} />
      )}

      {changed ? (
        <div className="grid gap-3 rounded-xl border border-line bg-surface p-4 sm:p-5">
          <p className="text-ink">Your sources changed since your last score.</p>
          {wait ? <p className="text-sm text-ink-muted">You can update it in {wait} seconds.</p> : null}
          <div className="w-fit">
            <RescoreButton label="Update my score" />
          </div>
        </div>
      ) : null}

      {done ? <VerifyPrompt x={x} github={github} /> : null}

      {answers.roles.length > 0 ? (
        <div className="grid gap-4">
          {answers.roles.map((role) => {
            const row = scores.get(role) ?? null;
            const card = cards.find((c) => c.role === role) ?? null;
            return (
              <RoleCard
                key={role}
                view={explainRole(role, row, state)}
                back={row ? cardBack(row.breakdown_json, state.counted) : null}
                defaultName={defaultName}
                eligibility={cardEligibility(role, reasonOf(row?.breakdown_json), verified)}
                active={card}
                sealSeed={card ? sealSeed({ wallet, slug: card.slug }) : null}
              />
            );
          })}
        </div>
      ) : null}

      <SourcesPanel identities={identities} />

      {done && consent && !active && !changed && status.job?.status !== "failed" ? (
        <div className="grid gap-2">
          <p className="text-sm text-ink-muted">Changed something on X, GitHub or onchain? Update your score.</p>
          <div className="w-fit">
            <RescoreButton label="Update my score" variant="outline" />
          </div>
        </div>
      ) : null}
    </section>
  );
}
