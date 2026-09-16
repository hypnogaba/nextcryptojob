import type { Metadata } from "next";
import Link from "next/link";
import { CardFront } from "@/components/card/card-front";
import { ROLES, isRoleKey, type RoleKey } from "@/lib/card/roles";
import { sealSeed } from "@/lib/card/seal";
import { cardPath } from "@/lib/card/share";
import { tierFor } from "@/lib/card/tiers";
import { summaryOf, type CardFace } from "@/lib/card/view";
import { db } from "@/lib/db";
import { POSITION_CODE } from "@/lib/roles/recipes";

export const metadata: Metadata = {
  title: "Leaderboard",
  description: "Everyone's public NextCryptoJob card, ranked by score.",
};

// Читає D1 напряму (без cookies()/сесії, Next інакше спробував би зробити сторінку статичною
// на збірці, де getCloudflareContext синхронно недоступний, як і в /jobs/[id]).
export const dynamic = "force-dynamic";

/**
 * Раунд 5, п.7: усі, хто має публічну картку й не вимкнув її в Privacy (/settings, "Show my card
 * on the leaderboard"), за балом.
 *
 * Раунд 6 (власник 16.09: «скореборд повинен бути скорербордом згори вниз, і варто натиснути на
 * картку, щоб побачити, які там бали в людини за що; публічно, видно навіть без акаунта»):
 * табло рядками згори вниз, місце, картка, нік, роль, рівень і бал; увесь рядок веде на публічну
 * сторінку картки /c/<slug>, де вже є розбір балу за джерелами. Сторінка без входу, пункт у шапці.
 */

type Row = {
  slug: string;
  role: string;
  score: number;
  level: number;
  display_name: string;
};

const MAX_ROWS = 300;

async function loadBoard(): Promise<Row[]> {
  const { results } = await db()
    .prepare(
      `SELECT c.slug, c.role, c.score, c.level, c.display_name
         FROM cards c JOIN users u ON u.id = c.user_id
        WHERE c.revoked_at IS NULL AND u.card_public = 1
        ORDER BY c.score DESC, c.created_at ASC
        LIMIT ?`,
    )
    .bind(MAX_ROWS)
    .all<Row>();
  return results;
}

function faceFor(row: Row, rank: number): CardFace | null {
  if (!isRoleKey(row.role)) return null;
  const role: RoleKey = row.role;
  const tier = tierFor(row.level);
  const face: CardFace = {
    kind: "real",
    roleName: ROLES[role].name,
    positionCode: POSITION_CODE[role],
    score: row.score,
    level: row.level,
    tier,
    displayName: row.display_name,
    sealSeed: sealSeed({ slug: row.slug }),
    number: `No. ${row.slug}`,
    marker: rank <= 3 ? `#${rank}` : null,
    summary: "",
  };
  face.summary = summaryOf(face);
  return face;
}

export default async function LeaderboardPage() {
  const board = await loadBoard();

  return (
    <section className="mx-auto max-w-[900px] px-[clamp(16px,4vw,32px)] pt-8 pb-24 sm:pt-14">
      <p className="ncj-label">Leaderboard</p>
      <h1 className="display text-title">Every public card, ranked by score</h1>
      <p className="mt-3 max-w-[60ch] text-lg text-ink-muted">
        Anyone who created a card and kept it on the leaderboard. Open a card to see how that score was built, source
        by source. Turn yours off any time in{" "}
        <Link href="/settings" className="font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand">
          Settings
        </Link>
        .
      </p>

      {board.length === 0 ? (
        <p className="mt-10 text-ink-muted">No public cards yet. Be the first: make a card from your profile.</p>
      ) : (
        <ol className="mt-10 grid gap-3">
          {board.map((row, i) => {
            const rank = i + 1;
            const face = faceFor(row, rank);
            if (!face) return null;
            return (
              <li key={row.slug}>
                <Link
                  href={cardPath(row.slug)}
                  aria-label={`${face.summary} See how this score was built.`}
                  className="group flex items-center gap-4 rounded-2xl border-[1.5px] border-line bg-surface p-3 transition-[border-color,background-color] duration-200 hover:border-line-strong hover:bg-soft has-[:focus-visible]:border-line-strong sm:gap-6 sm:p-4"
                >
                  <span className="w-8 shrink-0 text-center font-display text-xl font-semibold tabular-nums text-ink-muted sm:w-12 sm:text-3xl">
                    {rank}
                  </span>
                  <span className="ncj-card w-[132px] shrink-0 sm:w-[200px]">
                    <CardFront face={face} hideTag />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-lg font-semibold text-ink">{row.display_name}</span>
                    <span className="mt-0.5 block text-sm text-ink-muted">
                      {ROLES[row.role as RoleKey].name} · Level {row.level} of 10
                    </span>
                    <span className="mt-2 block text-sm text-ink-muted underline decoration-line-strong underline-offset-4 group-hover:decoration-brand">
                      See how this score was built
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block font-display text-3xl leading-none font-extrabold tabular-nums text-ink sm:text-5xl">
                      {row.score}
                    </span>
                    <span className="mt-1 block text-xs text-ink-muted">of 100</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
