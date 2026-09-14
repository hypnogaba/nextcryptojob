import type { CSSProperties } from "react";
import { roughCount } from "@/lib/jobs/instant";
import { type HomeBoard, updatedAgo } from "@/lib/jobs/home-board";
import { JobTicker } from "./job-ticker";
import { Odometer } from "./odometer";
import { RollOnView } from "./roll-on-view";

const WRAP = "mx-auto max-w-[1240px] px-[clamp(16px,4vw,56px)]";
const NUM = "ncj-live-num";

/**
 * Живий рядок під героєм: одне речення з числами з пулу вакансій і стрічка вакансій із зарплатою.
 * Числа округлені вниз (roughCount) і прокручуються один раз (Odometer); «оновлено» = коли скан
 * востаннє бачив вакансію. Без бази вакансій рядка немає: пояснення дає приклад листа в герої.
 */
export function LiveBoard({ board, now }: { board: Extract<HomeBoard, { available: true }>; now: number }) {
  const s = board.stats;
  const n = (value: number, i: number) => (
    <Odometer value={roughCount(value)} className={NUM} style={{ "--odo-delay": `${i * 90}ms` } as CSSProperties} />
  );
  const ago = updatedAgo(s.updatedMs, now);
  const note = [`${roughCount(s.newThisWeek)} new this week.`, ago ? `Updated ${ago}.` : null].filter(Boolean).join(" ");

  return (
    <section aria-labelledby="live-h" className="ncj-live">
      <h2 id="live-h" className="sr-only">
        Jobs right now
      </h2>
      <RollOnView className={`${WRAP} flex flex-wrap items-baseline justify-between gap-x-10 gap-y-1.5 py-5 sm:py-6`}>
        <p className="text-[1.0625rem] leading-relaxed text-ink sm:text-xl">
          {n(s.live, 0)} live crypto jobs at {n(s.companies, 1)} companies
          {s.sources > 0 ? (
            <>
              , from {n(s.sources, 2)} source{s.sources === 1 ? "" : "s"}
            </>
          ) : null}
          .
        </p>
        <p className="text-sm text-ink-muted">{note}</p>
      </RollOnView>
      <JobTicker jobs={board.ticker} />
    </section>
  );
}
