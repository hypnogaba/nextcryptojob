import Link from "next/link";
import { CardBackFace } from "@/components/card/card-back";
import { CardFront } from "@/components/card/card-front";
import { Button } from "@/components/ui/button";
import type { CardBack } from "@/lib/card/back";
import { frontStats } from "@/lib/card/back";
import type { Eligibility } from "@/lib/card/eligibility";
import { cardPath } from "@/lib/card/share";
import type { ActiveCard } from "@/lib/card/store";
import { displayScore, tierFor } from "@/lib/card/tiers";
import { formatIssuedOn, summaryOf, type CardFace } from "@/lib/card/view";
import { POSITION_CODE } from "@/lib/roles/recipes";
import type { RoleView } from "@/lib/score/explain";
import { CreateCardForm } from "./create-card-form";

const LINK = "font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand";

function Notes({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="grid gap-1.5">
      <h3 className="font-sans text-sm font-semibold text-ink">{title}</h3>
      <ul className="grid gap-1 text-sm text-ink-muted">
        {items.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </div>
  );
}

const EDIT_SOURCES = (
  <Link href="/welcome?step=sources" className={`text-sm ${LINK}`}>
    Edit sources
  </Link>
);

type Scored = Extract<RoleView, { state: "scored" }>;

/** Картка для будь-якої ролі з балом (модель довіри 13.09); для ролі без балу вимкнена кнопка й пояснення. */
function CardArea({
  view,
  defaultName,
  eligibility,
  active,
}: {
  view: Scored;
  defaultName: string;
  eligibility: Eligibility;
  active: ActiveCard | null;
}) {
  const stale = active && displayScore(active.score) !== view.score;
  const issued = active ? (
    <p className="text-sm text-ink">
      Your public card:{" "}
      <Link href={cardPath(active.slug)} className={LINK}>
        {cardPath(active.slug)}
      </Link>
      {stale
        ? `. It shows ${displayScore(active.score)} from ${formatIssuedOn(active.createdAt)}. Create a new card to show ${view.score}.`
        : "."}
    </p>
  ) : null;
  if (!eligibility.ok) {
    return (
      <div className="grid gap-2 border-t border-line pt-4">
        {issued}
        <Button disabled size="lg" className="w-full sm:w-fit" aria-describedby={`card-why-${view.role}`}>
          Create my card
        </Button>
        <p id={`card-why-${view.role}`} className="text-sm text-ink-muted">
          {eligibility.reason}
        </p>
      </div>
    );
  }
  return (
    <div className="grid gap-3 border-t border-line pt-4">
      {issued}
      <CreateCardForm role={view.role} defaultName={active?.displayName ?? defaultName} />
    </div>
  );
}

/** Лицьовий бік з поточним балом. Печатка є лише у виданої картки (з її slug або гаманця). */
function faceFor(view: Scored, back: CardBack | null, active: ActiveCard | null, seal: number | null, name: string): CardFace {
  const tier = tierFor(view.level);
  const face: CardFace = {
    kind: active ? "real" : "draft",
    roleName: view.name,
    positionCode: POSITION_CODE[view.role],
    score: view.score,
    level: tier.level,
    tier,
    displayName: active?.displayName ?? (name || "Your name"),
    sealSeed: active ? seal : null,
    stats: frontStats(back),
    number: active ? `No. ${active.slug}` : null,
    marker: null,
    summary: "",
  };
  face.summary = summaryOf(face);
  return face;
}

/** Одна роль на сторінці балу: лицьовий бік і зворот картки, прогалини, поради, картка. */
export function RoleCard({
  view,
  back,
  defaultName,
  eligibility,
  active,
  sealSeed,
}: {
  view: RoleView;
  /** Зворот з breakdown_json ролі або null. */
  back: CardBack | null;
  defaultName: string;
  eligibility: Eligibility;
  /** Активна картка ролі або null. */
  active: ActiveCard | null;
  /** Зерно печатки активної картки або null. */
  sealSeed: number | null;
}) {
  return (
    <article aria-labelledby={`role-${view.role}`} className="grid gap-5 rounded-xl border border-line bg-surface p-4 sm:p-6">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line pb-4">
        <h2 id={`role-${view.role}`} className="display text-[2rem] leading-none">
          {view.name}
        </h2>
        {view.state === "scored" ? (
          <p className="text-sm text-ink-muted">
            Score {view.score}, level {view.level} of 10, {tierFor(view.level).finishName.toLowerCase()} finish
          </p>
        ) : null}
      </header>

      {view.state === "waiting" ? <p className="text-sm text-ink-muted">Waiting for your score.</p> : null}
      {view.state === "unscored" ? <p className="text-sm text-ink-muted">{view.note}.</p> : null}

      {view.state === "missing" ? (
        <>
          <p className="text-ink">{view.reason}</p>
          <Notes title="Could not read" items={view.gaps} />
          <Notes title="Tips" items={view.tips} />
          <div>{EDIT_SOURCES}</div>
        </>
      ) : null}

      {view.state === "scored" ? (
        <>
          <div className="grid justify-items-center gap-5 md:grid-cols-2">
            <div className="ncj-card max-w-[340px]">
              <CardFront face={faceFor(view, back, active, sealSeed, defaultName)} />
            </div>
            <div className="ncj-card max-w-[340px]">
              <CardBackFace
                face={faceFor(view, back, active, sealSeed, defaultName)}
                back={back}
                meta={`Formula ${view.formulaVersion}, checked ${formatIssuedOn(view.computedAt)}.`}
              />
            </div>
          </div>
          {view.reason ? <p className="text-sm text-ink-muted">{view.reason}</p> : null}
          <p className="text-sm text-ink-muted">We found data for {view.cover}% of what this score counts.</p>
          <Notes title="Could not read" items={view.gaps} />
          <Notes title="Tips" items={view.tips} />
          <CardArea view={view} defaultName={defaultName} eligibility={eligibility} active={active} />
        </>
      ) : null}
    </article>
  );
}
