import type { CSSProperties } from "react";
import { roughCount } from "@/lib/jobs/instant";
import { type HomeBoard, updatedAgo } from "@/lib/jobs/home-board";
import { JobTicker } from "./job-ticker";
import { Odometer } from "./odometer";
import { RollOnView } from "./roll-on-view";

const WRAP = "mx-auto max-w-[1240px] px-[clamp(16px,4vw,56px)]";

/**
 * Табло під героєм: чотири лічильники з пулу вакансій і стрічка вакансій із зарплатою.
 * Числа округлені вниз (roughCount), «оновлено» = коли скан востаннє бачив вакансію.
 * Без бази вакансій табло лишається, але з одним рядком замість чисел.
 */
export function LiveBoard({ board, now }: { board: HomeBoard; now: number }) {
  if (!board.available) {
    return (
      <section aria-labelledby="live-h" className="ncj-board">
        <div className={`${WRAP} py-6`}>
          <h2 id="live-h" className="sr-only">
            Jobs right now
          </h2>
          <p className="max-w-[60ch] text-[var(--board-muted)]">
            Live job counts did not load just now. Your brief still works: we show your matches as soon as the jobs load.
          </p>
        </div>
      </section>
    );
  }

  const s = board.stats;
  const cells = [
    { label: "Live crypto jobs", n: s.live },
    { label: "New this week", n: s.newThisWeek },
    { label: "Companies hiring", n: s.companies },
    { label: "With salary listed", n: s.withSalary },
  ];
  const ago = updatedAgo(s.updatedMs, now);
  const note = [
    s.sources > 0 ? `From ${s.sources} job source${s.sources === 1 ? "" : "s"}.` : null,
    ago ? `Updated ${ago}.` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section aria-labelledby="live-h" className="ncj-board">
      <h2 id="live-h" className="sr-only">
        Jobs right now
      </h2>
      <RollOnView className={WRAP}>
        <dl className="grid grid-cols-2 lg:grid-cols-4">
          {cells.map((c, i) => (
            <div key={c.label} className="ncj-board-cell">
              <dt className="text-[0.9375rem] leading-snug text-[var(--board-muted)]">{c.label}</dt>
              <dd>
                <Odometer
                  value={roughCount(c.n)}
                  className="ncj-board-num"
                  style={{ "--odo-delay": `${i * 70}ms` } as CSSProperties}
                />
              </dd>
            </div>
          ))}
        </dl>
        {note ? <p className="ncj-board-note">{note}</p> : null}
      </RollOnView>
      <JobTicker jobs={board.ticker} />
    </section>
  );
}
