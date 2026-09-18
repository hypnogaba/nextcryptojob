import type { CSSProperties } from "react";
import { JobFeed } from "@/components/landing/job-feed";
import { Odometer } from "@/components/landing/odometer";
import { RollOnView } from "@/components/landing/roll-on-view";
import { appEnv, db } from "@/lib/db";
import { homeBoard, updatedAgo } from "@/lib/jobs/home-board";
import { roughCount } from "@/lib/jobs/instant";
import { jobsDb } from "@/lib/jobs-db";

// Табло головної окремим шматком: сторінка віддає каркас одразу, а числа й стрічку доганяє
// через <Suspense> (замір 18.09: холодний ізолят читав пул з D1 1 до 2,4 с, і весь цей час
// людина не бачила ні заголовка, ні форми). Табло кешується в краю, home-board.ts EDGE_TTL_S.

/** Скільки рядків у стрічці панелі: сьогоднішні п'ять і далі стрічка. */
const FEED_SIZE = 14;

/** Рамка табло: та сама розмітка для каркаса й для готових чисел, щоб сторінка не стрибала. */
function Frame({ title, chips, children }: { title: React.ReactNode; chips?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="ncj-board">
      <div className="ncj-board-h">
        <h2
          id="board-h"
          className="font-display text-[1.375rem] leading-7 font-bold tracking-[-0.02em] sm:text-[1.875rem] sm:leading-9"
        >
          {title}
        </h2>
        {chips}
      </div>
      <section id="today" aria-labelledby="board-h" className="ncj-sheet-jobs scroll-mt-24">
        {children}
      </section>
    </div>
  );
}

/** Що видно, поки табло їде: та сама рамка й заголовок без числа. */
export function HomeBoardShell() {
  return (
    <Frame title="Live jobs">
      <p className="px-1 pb-4 text-ink-muted" aria-live="polite">
        Loading today&apos;s jobs.
      </p>
    </Frame>
  );
}

export async function HomeBoard() {
  const now = new Date();
  const board = await homeBoard({ db, env: safeEnv(), jobs: jobsDb, now });
  const feed = board.available ? [...board.today.jobs, ...board.ticker].slice(0, FEED_SIZE) : [];
  const s = board.available ? board.stats : null;
  const ago = s ? updatedAgo(s.updatedMs, now.getTime()) : null;

  return (
    <Frame
      title={
        s ? (
          <RollOnView className="inline">
            <Odometer value={roughCount(s.live)} style={{ "--odo-delay": "0ms" } as CSSProperties} /> live jobs
          </RollOnView>
        ) : (
          "Live jobs"
        )
      }
      chips={
        s ? (
          <div className="ncj-chip-row">
            <span className="ncj-chip-pill">
              {s.sources > 0 ? `${roughCount(s.sources)} sources` : `${roughCount(s.companies)} companies`}
            </span>
            <span className="ncj-chip-pill">
              <i className="ncj-pulse-dot" aria-hidden="true" />
              Updated daily
            </span>
            {ago ? <span className="ncj-chip-pill">Last check {ago}</span> : null}
          </div>
        ) : null
      }
    >
      {feed.length > 0 ? (
        <JobFeed jobs={feed} />
      ) : (
        <p className="px-1 pb-4 text-ink-muted">
          Today&apos;s jobs did not load just now. Your brief still works: we show your matches as soon as they load.
        </p>
      )}
    </Frame>
  );
}

/** SITE_URL для посилань на вакансії компаній; без оточення Worker порожньо (посилання відносні). */
function safeEnv(): { SITE_URL?: string } {
  try {
    return { SITE_URL: appEnv().SITE_URL };
  } catch {
    return {};
  }
}
