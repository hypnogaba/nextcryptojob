import { sumFunnelStep } from "@/lib/analytics/funnel";
import { loadVisits, utcDay } from "@/lib/analytics/visits";
import { sqlTime } from "@/lib/time";

/**
 * /admin/funnel (D): visitors → brief started →
 * X added → wallet added → score ready → card viewed → share on X click → digest active →
 * apply clicks, за 1/7/30 днів, з конверсією між кроками.
 *
 * Джерела: visit_days (0021, відвідувачі й перегляди картки), funnel_days (0023, старт
 * брифу, клік «Share on X», клік «Apply»), identities/scores/users (0001, ядро).
 * "Digest active" не має вікна: це стан зараз, показаний однаково для 1/7/30 днів.
 */

export const FUNNEL_WINDOWS = [1, 7, 30] as const;
export type FunnelWindow = (typeof FUNNEL_WINDOWS)[number];

export type FunnelStepRow = {
  key: string;
  label: string;
  count: number;
  /** Частка від попереднього кроку, null для першого. */
  fromPrev: number | null;
};

export type FunnelDay = { day: string; visitors: number };

export type FunnelReport = {
  window: FunnelWindow;
  steps: FunnelStepRow[];
  days: FunnelDay[];
  visitsAvailable: boolean;
  visitsError: string | null;
};

const DAY_MS = 86_400_000;

/** Перегляди path_group = 'card' за діапазон днів. Таблиці ще немає: 0, без винятку (як loadVisits). */
async function cardViews(db: D1Database, from: string, to: string): Promise<number> {
  try {
    const row = await db
      .prepare("SELECT COALESCE(SUM(uniques), 0) AS n FROM visit_days WHERE path_group = 'card' AND day BETWEEN ? AND ?")
      .bind(from, to)
      .first<{ n: number }>();
    return Number(row?.n) || 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table/i.test(message)) return 0;
    throw error;
  }
}

async function distinctUserCount(db: D1Database, sql: string, sinceIso: string): Promise<number> {
  const row = await db.prepare(sql).bind(sinceIso).first<{ n: number }>();
  return Number(row?.n) || 0;
}

export async function loadFunnelReport(db: D1Database, window: FunnelWindow, now: Date = new Date()): Promise<FunnelReport> {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const from = utcDay(new Date(today - (window - 1) * DAY_MS));
  const to = utcDay(new Date(today));
  const sinceIso = sqlTime(new Date(today - (window - 1) * DAY_MS));

  const [visits, briefStarted, xAdded, walletAdded, scoreReady, cardViewed, shareClicks, digestActive, applyClicks] = await Promise.all([
    loadVisits(db, now, window),
    sumFunnelStep(db, "brief_started", from, to),
    distinctUserCount(
      db,
      "SELECT COUNT(DISTINCT user_id) AS n FROM identities WHERE kind = 'x' AND created_at >= ?",
      sinceIso,
    ),
    distinctUserCount(
      db,
      "SELECT COUNT(DISTINCT user_id) AS n FROM identities WHERE kind IN ('evm', 'solana') AND created_at >= ?",
      sinceIso,
    ),
    distinctUserCount(
      db,
      "SELECT COUNT(DISTINCT user_id) AS n FROM scores WHERE score IS NOT NULL AND computed_at >= ?",
      sinceIso,
    ),
    cardViews(db, from, to),
    sumFunnelStep(db, "share_click", from, to),
    db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE roles <> '[]' AND COALESCE(digest_paused, 0) = 0 AND is_demo = 0")
      .first<{ n: number }>(),
    sumFunnelStep(db, "apply_click", from, to),
  ]);

  const raw = [
    { key: "visitors", label: "Visitors", count: visits.totals.uniques },
    { key: "brief_started", label: "Brief started", count: briefStarted.total },
    { key: "x_added", label: "X added", count: xAdded },
    { key: "wallet_added", label: "Wallet added", count: walletAdded },
    { key: "score_ready", label: "Score ready", count: scoreReady },
    { key: "card_viewed", label: "Card viewed", count: cardViewed },
    { key: "share_click", label: "Share on X click", count: shareClicks.total },
    { key: "digest_active", label: "Digest active (now)", count: Number(digestActive?.n) || 0 },
    { key: "apply_click", label: "Apply clicks", count: applyClicks.total },
  ];
  const steps: FunnelStepRow[] = raw.map((s, i) => ({
    ...s,
    fromPrev: i === 0 || raw[i - 1].count <= 0 ? null : s.count / raw[i - 1].count,
  }));

  return {
    window,
    steps,
    days: visits.days.map((d) => ({ day: d.day, visitors: d.uniques })),
    visitsAvailable: visits.available,
    visitsError: visits.error,
  };
}
