import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { suggestDisplayName } from "@/lib/card/display-name";
import { hasConsent, SCORING_CONSENT } from "@/lib/consent";
import { db } from "@/lib/db";
import { listIdentities } from "@/lib/identity/store";
import { loadAnswers } from "@/lib/onboarding/store";
import { explainRole } from "@/lib/score/explain";
import { loadScores } from "@/lib/score/load";
import { isActive, profileStatus } from "@/lib/score/status";
import { RescoreButton } from "./rescore-button";
import { RoleCard } from "./role-card";
import { SourcesPanel } from "./sources-panel";
import { StatusPanel } from "./status-panel";

export const metadata: Metadata = { title: "Your profile", robots: { index: false } };

/** Сторінка балу: ролі людини, бал кожної з поясненням, стан черги, джерела. */
export default async function ProfilePage() {
  const user = await requireUser();
  const d = db();
  const [answers, identities, status, scores, consent] = await Promise.all([
    loadAnswers(d, user.id),
    listIdentities(d, user.id),
    profileStatus(d, user.id),
    loadScores(d, user.id),
    hasConsent(d, user.id, SCORING_CONSENT.kind),
  ]);
  const done = answers.step === "done";
  const connected = new Set(identities.map((i) => i.kind));
  const verifiedX = identities.find((i) => i.kind === "x" && i.verifiedAt)?.value ?? null;
  const defaultName = suggestDisplayName(verifiedX, user.email);
  const active = isActive(status);

  return (
    <section className="mx-auto grid max-w-3xl gap-6 px-4 pt-8 pb-20 sm:px-6 sm:pt-14">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Your score</h1>
        {done ? (
          <Link
            href="/welcome"
            className="-mr-2 inline-flex min-h-11 items-center rounded-sm px-2 text-sm font-medium text-ink-muted hover:text-ink"
          >
            Edit answers
          </Link>
        ) : null}
      </div>

      {!done ? (
        <div className="grid gap-3 rounded-xl border border-line bg-surface p-4 sm:p-5">
          <p className="text-ink">Finish setting up your profile to get your score.</p>
          <Button asChild className="h-11 w-fit px-5 text-base">
            <Link href="/welcome">Continue setup</Link>
          </Button>
        </div>
      ) : (
        <StatusPanel key={`${status.job?.status ?? "none"}:${status.scored}`} initial={status} />
      )}

      {answers.roles.length > 0 ? (
        <div className="grid gap-4">
          {answers.roles.map((role) => (
            <RoleCard
              key={role}
              view={explainRole(role, scores.get(role) ?? null, connected)}
              defaultName={defaultName}
            />
          ))}
        </div>
      ) : null}

      <SourcesPanel identities={identities} />

      {done && consent && !active && status.job?.status !== "failed" ? (
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
