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
 *
 * Сторінки (власник 16.09, п.2 «якщо в нас буде 100 людей»): рядки менші (мініатюра картки,
 * відступи, шрифт), 25 на сторінку, `?page=` у запиті, читається на сервері — без стану на клієнті.
 */

type Row = {
  slug: string;
  role: string;
  score: number;
  level: number;
  display_name: string;
};

const PAGE_SIZE = 25;

function parsePage(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = value ? Number.parseInt(value, 10) : 1;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

async function loadBoard(page: number): Promise<{ rows: Row[]; hasNext: boolean }> {
  const offset = (page - 1) * PAGE_SIZE;
  // Тягнемо на один рядок більше за сторінку, щоб знати, чи є ще одна, без окремого count(*).
  const { results } = await db()
    .prepare(
      `SELECT c.slug, c.role, c.score, c.level, c.display_name
         FROM cards c JOIN users u ON u.id = c.user_id
        WHERE c.revoked_at IS NULL AND u.card_public = 1
        ORDER BY c.score DESC, c.created_at ASC
        LIMIT ? OFFSET ?`,
    )
    .bind(PAGE_SIZE + 1, offset)
    .all<Row>();
  return { rows: results.slice(0, PAGE_SIZE), hasNext: results.length > PAGE_SIZE };
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

type Props = { searchParams?: Promise<{ page?: string | string[] }> };

export default async function LeaderboardPage({ searchParams }: Props) {
  const page = parsePage((await searchParams)?.page);
  const { rows, hasNext } = await loadBoard(page);
  const rankOffset = (page - 1) * PAGE_SIZE;

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

      {rows.length === 0 && page === 1 ? (
        <p className="mt-10 text-ink-muted">No public cards yet. Be the first: make a card from your profile.</p>
      ) : (
        <>
          <ol className="mt-8 grid gap-1.5">
            {rows.map((row, i) => {
              const rank = rankOffset + i + 1;
              const face = faceFor(row, rank);
              if (!face) return null;
              return (
                <li key={row.slug}>
                  <Link
                    href={cardPath(row.slug)}
                    aria-label={`${face.summary} See how this score was built.`}
                    className="group flex items-center gap-3 rounded-xl border border-line bg-surface p-2 transition-[border-color,background-color] duration-200 hover:border-line-strong hover:bg-soft has-[:focus-visible]:border-line-strong sm:gap-4 sm:p-2.5"
                  >
                    <span className="w-6 shrink-0 text-center font-display text-sm font-semibold tabular-nums text-ink-muted sm:w-8 sm:text-base">
                      {rank}
                    </span>
                    <span className="ncj-card w-[44px] shrink-0 sm:w-[56px]">
                      <CardFront face={face} hideTag />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-ink sm:text-base">{row.display_name}</span>
                      <span className="mt-0.5 block truncate text-xs text-ink-muted">
                        {ROLES[row.role as RoleKey].name} · Level {row.level} of 10
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block font-display text-lg leading-none font-extrabold tabular-nums text-ink sm:text-xl">
                        {row.score}
                      </span>
                      <span className="mt-0.5 block text-[0.65rem] text-ink-muted">of 100</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>

          {page > 1 || hasNext ? (
            <nav aria-label="Leaderboard pages" className="mt-8 flex items-center justify-between gap-4">
              {page > 1 ? (
                <Link
                  href={page === 2 ? "/leaderboard" : `/leaderboard?page=${page - 1}`}
                  className="font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand"
                >
                  Previous
                </Link>
              ) : (
                <span />
              )}
              <span className="text-sm text-ink-muted">Page {page}</span>
              {hasNext ? (
                <Link
                  href={`/leaderboard?page=${page + 1}`}
                  className="font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand"
                >
                  Next
                </Link>
              ) : (
                <span />
              )}
            </nav>
          ) : null}
        </>
      )}
    </section>
  );
}
