import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { Eligibility } from "@/lib/card/eligibility";
import type { RoleView } from "@/lib/score/explain";
import { CreateCardForm } from "./create-card-form";
import { ScoreBar } from "./score-bar";

function Notes({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="grid gap-1.5">
      <h4 className="font-mono text-xs tracking-widest text-ink-muted uppercase">{title}</h4>
      <ul className="grid gap-1 text-sm text-ink">
        {items.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </div>
  );
}

const EDIT_SOURCES = (
  <Link href="/welcome?step=sources" className="text-sm font-medium text-brand underline underline-offset-4">
    Edit sources
  </Link>
);

/** Картка лише з підтвердженим головним джерелом; інакше вимкнена кнопка й пояснення. */
function CardArea({ view, defaultName, eligibility }: { view: RoleView; defaultName: string; eligibility: Eligibility }) {
  if (view.state !== "scored") return null;
  if (!eligibility.ok) {
    return (
      <div className="grid gap-2 border-t border-line pt-4">
        <Button disabled className="h-11 w-full px-5 text-base sm:w-fit" aria-describedby={`card-why-${view.role}`}>
          Create my card
        </Button>
        <p id={`card-why-${view.role}`} className="text-sm text-ink-muted">
          {eligibility.reason}
        </p>
      </div>
    );
  }
  return (
    <>
      {eligibility.walletsUnverified ? (
        <p className="border-t border-line pt-4 text-sm text-ink-muted">
          Your card will say Wallets not verified until you can prove your wallets with a signature.
        </p>
      ) : null}
      <CreateCardForm role={view.role} defaultName={defaultName} />
    </>
  );
}

/** Одна роль на сторінці балу: бал і рівень, за що він, прогалини, поради, картка. */
export function RoleCard({
  view,
  defaultName,
  eligibility,
}: {
  view: RoleView;
  defaultName: string;
  eligibility: Eligibility;
}) {
  return (
    <article className="grid gap-5 rounded-xl border border-line bg-surface p-4 sm:p-6">
      <header className="flex items-start justify-between gap-4">
        <h2 className="font-sans text-lg font-semibold text-ink">{view.name}</h2>
        {view.state === "scored" ? (
          <p className="text-right">
            <span className="font-mono text-3xl leading-none font-medium text-ink">{view.score}</span>
            <span className="block font-mono text-xs text-ink-muted">Level {view.level} of 10</span>
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
          {view.reason ? <p className="text-sm text-ink-muted">{view.reason}</p> : null}
          <div className="grid gap-2">
            <h3 className="font-mono text-xs tracking-widest text-ink-muted uppercase">What counts</h3>
            <ul className="grid gap-3">
              {view.core.map((bar) => (
                <ScoreBar key={bar.key} bar={bar} weightLabel={`${bar.weight}%`} />
              ))}
            </ul>
          </div>
          {view.bonus.length > 0 ? (
            <div className="grid gap-2">
              <h3 className="font-mono text-xs tracking-widest text-ink-muted uppercase">Bonus</h3>
              <ul className="grid gap-3">
                {view.bonus.map((bar) => (
                  <ScoreBar key={bar.key} bar={bar} weightLabel={`up to +${bar.weight}`} />
                ))}
              </ul>
            </div>
          ) : null}
          <p className="text-sm text-ink-muted">
            We found data for {view.cover}% of what this score counts.
          </p>
          <Notes title="Could not read" items={view.gaps} />
          <Notes title="Tips" items={view.tips} />
          <CardArea view={view} defaultName={defaultName} eligibility={eligibility} />
        </>
      ) : null}
    </article>
  );
}
