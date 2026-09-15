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
 * on the leaderboard"), за балом. Лише картинка картки, бал і нік вже на ній самій: нічого
 * додаткового тут не показуємо (жодного розбору, жодних посилань на джерела).
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
    <section className="mx-auto max-w-[1280px] px-[clamp(16px,4vw,32px)] pt-8 pb-24 sm:pt-14">
      <p className="ncj-label">Leaderboard</p>
      <h1 className="display text-title">Every public card, ranked by score</h1>
      <p className="mt-3 max-w-[60ch] text-lg text-ink-muted">
        Anyone who created a card and kept it on the leaderboard. Turn yours off any time in{" "}
        <Link href="/settings" className="font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand">
          Settings
        </Link>
        .
      </p>

      {board.length === 0 ? (
        <p className="mt-10 text-ink-muted">No public cards yet. Be the first: make a card from your profile.</p>
      ) : (
        <ol className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {board.map((row, i) => {
            const face = faceFor(row, i + 1);
            if (!face) return null;
            return (
              <li key={row.slug}>
                <Link href={cardPath(row.slug)} aria-label={face.summary} className="block">
                  <div className="ncj-card w-full">
                    <CardFront face={face} hideTag />
                  </div>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
