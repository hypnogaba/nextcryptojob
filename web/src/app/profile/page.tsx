import type { Metadata } from "next";
import Link from "next/link";
import { AccountShell } from "@/components/account-nav";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { suggestDisplayName } from "@/lib/card/display-name";
import { cardEligibility } from "@/lib/card/eligibility";
import { hasScoringBasis } from "@/lib/consent";
import { db } from "@/lib/db";
import { listIdentities } from "@/lib/identity/store";
import { briefDone } from "@/lib/onboarding/steps";
import { loadAnswers } from "@/lib/onboarding/store";
import { cardBack } from "@/lib/card/back";
import { sealSeed } from "@/lib/card/seal";
import { listActiveCards } from "@/lib/card/store";
import { explainRole, hasStaleVerifyGap, sourceState } from "@/lib/score/explain";
import { loadScores } from "@/lib/score/load";
import { isActive, profileStatus } from "@/lib/score/status";
import { parseWait } from "../welcome/flow";
import { RescoreButton } from "./rescore-button";
import { RoleCard } from "./role-card";
import { SourcesPanel } from "./sources-panel";
import { StatusPanel } from "./status-panel";

export const metadata: Metadata = { title: "Your profile", robots: { index: false } };

type Props = { searchParams: Promise<{ wait?: string | string[] }> };

/** Сторінка балу: ролі людини, бал кожної з поясненням, стан черги, джерела. */
export default async function ProfilePage({ searchParams }: Props) {
  const user = await requireUser();
  const d = db();
  const [answers, identities, status, scores, consent, cards] = await Promise.all([
    loadAnswers(d, user.id),
    listIdentities(d, user.id),
    profileStatus(d, user.id),
    loadScores(d, user.id),
    hasScoringBasis(d, user.id),
    listActiveCards(d, user.id),
  ]);
  // Анкету пройдено й умови прийнято: бал уже рахується, навіть якщо «Stand out» ще попереду.
  const done = briefDone(answers.step);
  const state = sourceState(identities);
  const x = identities.find((i) => i.kind === "x") ?? null;
  const hasWallet = identities.some((i) => i.kind === "evm" || i.kind === "solana");
  // Модель довіри 13.09: нік X, який людина вписала, іде в ім'я на картці й без коду.
  const defaultName = suggestDisplayName(x?.value ?? null, user.email);
  const active = isActive(status);
  const wait = parseWait((await searchParams).wait);
  // Бал, порахований до 13.09 без X чи GitHub (прогалина «not verified»), теж просить оновлення.
  const stale = [...scores.values()].some((r) => hasStaleVerifyGap(r.breakdown_json));
  const changed = done && consent && (status.sourcesChanged || stale) && !active;
  // Печатка з підтвердженого гаманця, інакше зі slug картки (підпису гаманців у релізі 1 ще немає).
  const wallet = identities.find((i) => (i.kind === "evm" || i.kind === "solana") && i.verifiedAt)?.value ?? null;

  return (
    <AccountShell active="card" title="Your card and score">
      <div className="grid gap-6">
      {done ? (
        <div className="-mt-2 flex justify-end">
          <Link
            href="/welcome"
            className="-mr-2 inline-flex min-h-11 items-center px-2 text-sm font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand"
          >
            Edit answers
          </Link>
        </div>
      ) : null}

      {!done ? (
        <div className="grid gap-3 rounded-xl border border-line bg-surface p-4 sm:p-5">
          <p className="text-ink">Finish your brief to get jobs and your score.</p>
          <Button asChild size="lg" className="w-fit">
            <Link href="/welcome">Continue setup</Link>
          </Button>
        </div>
      ) : (
        <StatusPanel key={`${status.job?.status ?? "none"}:${status.scored}`} initial={status} />
      )}

      {changed ? (
        <div className="grid gap-3 rounded-xl border border-line bg-surface p-4 sm:p-5">
          <p className="text-ink">
            {status.sourcesChanged
              ? "Your sources changed since your last score."
              : "We now count your X, GitHub and wallets as you typed them, without a code. Update your score to include them."}
          </p>
          {wait ? <p className="text-sm text-ink-muted">You can update it in {wait} seconds.</p> : null}
          <div className="w-fit">
            <RescoreButton label="Update my score" />
          </div>
        </div>
      ) : null}

      {done && !x ? (
        <div className="grid gap-2 rounded-xl border-[1.5px] border-line bg-surface p-4 sm:p-5">
          <p className="text-sm text-ink">
            Add your X account. Most roles are scored from X, and your score and card need it. Just type your handle.
          </p>
          <Link
            href="/welcome?step=x"
            className="inline-flex min-h-11 w-fit items-center text-sm font-semibold text-brand underline underline-offset-4"
          >
            Add X
          </Link>
        </div>
      ) : null}

      {done && !hasWallet ? (
        <div className="grid gap-2 rounded-xl border-[1.5px] border-line bg-surface p-4 sm:p-5">
          {/* Гаманець став обов'язковим 15.09 (як X); хто вже мав акаунт без нього, ми не блокуємо,
              лише пропонуємо додати (власник 15.09, п.5). */}
          <p className="text-sm text-ink">
            Add a wallet. It is now part of the brief, like X: onchain history counts for every role and is the whole
            Trader score.
          </p>
          <Link
            href="/welcome?step=wallets"
            className="inline-flex min-h-11 w-fit items-center text-sm font-semibold text-brand underline underline-offset-4"
          >
            Add a wallet
          </Link>
        </div>
      ) : null}

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
                eligibility={cardEligibility(role)}
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
      </div>
    </AccountShell>
  );
}
