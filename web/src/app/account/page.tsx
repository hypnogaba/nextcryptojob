import type { Metadata } from "next";
import Link from "next/link";
import { AccountShell } from "@/components/account-nav";
import { AdminNav } from "@/components/admin-nav";
import { CardFront } from "@/components/card/card-front";
import { Button } from "@/components/ui/button";
import { isAdminSession } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/session";
import { cardPath } from "@/lib/card/share";
import { sealSeed } from "@/lib/card/seal";
import { listActiveCards } from "@/lib/card/store";
import { displayScore, levelFor, tierFor } from "@/lib/card/tiers";
import { summaryOf, type CardFace } from "@/lib/card/view";
import { appEnv, db } from "@/lib/db";
import { listIdentities } from "@/lib/identity/store";
import { briefDone } from "@/lib/onboarding/steps";
import { loadAnswers } from "@/lib/onboarding/store";
import { ROLES, type RoleKey } from "@/lib/card/roles";
import { POSITION_CODE } from "@/lib/roles/recipes";
import { loadScores } from "@/lib/score/load";
import { ScoreReadyWatcher } from "./score-ready-watcher";

export const metadata: Metadata = { title: "Account", robots: { index: false } };

/** Мала жива картка в огляді: та сама анатомія, що на профілі, лише менша (ncj-card масштабує cqw). */
function overviewFace(card: { slug: string; role: RoleKey; score: number; displayName: string }, wallet: string | null): CardFace {
  const level = levelFor(card.score);
  const face: CardFace = {
    kind: "real",
    roleName: ROLES[card.role].name,
    positionCode: POSITION_CODE[card.role],
    score: displayScore(card.score),
    level,
    tier: tierFor(level),
    displayName: card.displayName,
    sealSeed: sealSeed({ wallet, slug: card.slug }),
    number: `No. ${card.slug}`,
    marker: null,
    summary: "",
  };
  face.summary = summaryOf(face);
  return face;
}

/** Один пункт «Далі»: посилання, головний текст, дрібний підпис праворуч. */
function NextStep({ href, children, note }: { href: string; children: string; note: string }) {
  return (
    <Link href={href} className="flex min-h-14 items-center justify-between gap-4 border-b border-line px-4 last:border-b-0 hover:bg-soft">
      <span className="font-medium text-ink">{children}</span>
      <span className="text-sm text-ink-muted">{note}</span>
    </Link>
  );
}

// Кабінет, round4 (макет design-round4/dir-6): огляд з бічним меню (AccountShell), мала жива
// картка, три жетони й список «Далі» з реальних даних. Пошта, Telegram і вихід переїхали в
// Settings (власник 15.09, п.7): Sign-in там же, поруч Daily jobs і Privacy.
export default async function AccountPage() {
  const user = await requireUser();
  const d = db();
  const [{ step }, identities, cards, scores] = await Promise.all([
    loadAnswers(d, user.id),
    listIdentities(d, user.id),
    listActiveCards(d, user.id),
    loadScores(d, user.id),
  ]);
  const admin = isAdminSession(user, (appEnv() as { ADMIN_EMAILS?: string }).ADMIN_EMAILS);
  const hasX = identities.some((i) => i.kind === "x");
  const hasWallet = identities.some((i) => i.kind === "evm" || i.kind === "solana");
  const hasGithub = identities.some((i) => i.kind === "github");
  const wallet = identities.find((i) => (i.kind === "evm" || i.kind === "solana") && i.verifiedAt)?.value ?? null;
  const best = cards.length > 0 ? cards.reduce((a, b) => (b.score > a.score ? b : a)) : null;

  if (!briefDone(step)) {
    return (
      <AccountShell active="overview" title="Account" sub="Finish your brief to unlock jobs and your score.">
        <div className="grid gap-3 rounded-xl border border-line bg-surface p-4 sm:p-5">
          <p className="text-ink">Finish your brief to get jobs and your score.</p>
          <Button asChild size="lg" className="w-fit">
            <Link href="/welcome">Continue setup</Link>
          </Button>
        </div>
        {admin ? <AdminNav className="mt-10" /> : null}
      </AccountShell>
    );
  }

  // Раунд 5, п.2 + п.14: людина, хто «Skip»-нула чекання балу (welcome/score/scoring-wait.tsx),
  // бачить тут «Your card is ready», коли рушій закінчить, без повернення на ту сторінку.
  // 17.09 (власник: «картка сама не створилась»): чекаємо картку кожному, хто пройшов анкету, а
  // не лише тим, хто додав X. Бал буває і з гаманця чи GitHub, а картка мусить з'явитись сама.
  const watchScore = cards.length === 0;

  return (
    <AccountShell active="overview" title="Account" sub="Your card, your jobs and your settings, in one place.">
      <ScoreReadyWatcher watch={watchScore} />
      <h2 className="mt-6 display text-[1.75rem] leading-none">
        Welcome back{user.email ? `, ${user.email.split("@")[0]}` : ""}
      </h2>
      <p className="mt-1 text-ink-muted">
        {best ? `Your card shows level ${levelFor(best.score)} of 10.` : "You have not created a card yet."}
      </p>

      <div className="mt-6 grid items-start gap-6 sm:grid-cols-[220px_1fr]">
        {best ? (
          <div className="ncj-card w-full max-w-[220px]">
            <CardFront face={overviewFace(best, wallet)} />
          </div>
        ) : (
          <div className="grid aspect-[1.586] w-full max-w-[220px] place-items-center rounded-2xl border-[1.5px] border-dashed border-line-strong p-4 text-center text-sm text-ink-muted">
            No card yet
          </div>
        )}
        <div className="grid gap-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl border border-line p-3.5">
              <span className="text-sm text-ink-muted">Sources</span>
              <b className="block font-display text-[1.75rem] leading-none">{identities.length}</b>
            </div>
            <div className="rounded-xl border border-line p-3.5">
              <span className="text-sm text-ink-muted">Roles scored</span>
              <b className="block font-display text-[1.75rem] leading-none">{scores.size}</b>
            </div>
            {/* Одна картка на людину (раунд 5, п.7): рахунок карток тут не потрібен, лише її
                стан, тому не "Cards" з числом, а "Card" зі станом (власник 16.09, п.7). */}
            <div className="rounded-xl border border-line p-3.5">
              <span className="text-sm text-ink-muted">Card</span>
              <b className="block font-display text-[1.75rem] leading-none">{best ? "Live" : "Not yet"}</b>
            </div>
          </div>

          <div className="rounded-xl border border-line">
            {!hasX ? (
              <NextStep href="/welcome?step=x" note="Required">
                Add your X account
              </NextStep>
            ) : null}
            {!hasWallet ? (
              <NextStep href="/welcome?step=wallets" note="Required">
                Add a wallet
              </NextStep>
            ) : null}
            {!hasGithub ? (
              <NextStep href="/welcome?step=sources" note="Optional, raises your score">
                Add a GitHub account
              </NextStep>
            ) : null}
            {best ? (
              <NextStep href={cardPath(best.slug)} note="Open card">
                Share your card on X
              </NextStep>
            ) : (
              <NextStep href="/profile" note="See your score">
                Create your card
              </NextStep>
            )}
            <NextStep href="/jobs" note="See jobs">
              See today&apos;s jobs
            </NextStep>
          </div>
        </div>
      </div>

      {admin ? <AdminNav className="mt-10" /> : null}
    </AccountShell>
  );
}
