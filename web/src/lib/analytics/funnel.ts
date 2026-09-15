import { utcDay } from "./visits";

/**
 * Кроки продуктової воронки, яких інші таблиці не дають напряму (funnel_days, 0023).
 * Денний лічильник без прив'язки до людини: день, крок, скільки разів. Той самий підхід,
 * що visit_days (0021), але без хешу відвідувача: тут не потрібна навіть уникальність,
 * лише скільки разів подія сталась за день.
 *
 * Решта кроків воронки (/admin/funnel) рахуються з наявних таблиць у lib/admin/funnel.ts.
 */
export const FUNNEL_STEPS = ["brief_started", "share_click", "apply_click"] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

/** +1 до лічильника кроку за сьогодні (UTC). Не кидає: лічильник не має ламати запит. */
export async function recordFunnelEvent(db: D1Database, step: FunnelStep, now: Date = new Date()): Promise<void> {
  const day = utcDay(now);
  try {
    await db
      .prepare(
        `INSERT INTO funnel_days (day, step, count) VALUES (?, ?, 1)
           ON CONFLICT (day, step) DO UPDATE SET count = count + 1`,
      )
      .bind(day, step)
      .run();
  } catch (error) {
    console.error("funnel: not counted", step, error instanceof Error ? error.message : String(error));
  }
}

export type FunnelDaySums = { total: number; byDay: Map<string, number> };

/**
 * Сума лічильника кроку за діапазон днів [from, to] (включно), і розклад за днем.
 * Таблиці ще немає (0023 не накочено) або база не відповіла: 0 і порожній розклад,
 * без винятку (той самий підхід, що loadVisits у visits.ts).
 */
export async function sumFunnelStep(db: D1Database, step: FunnelStep, from: string, to: string): Promise<FunnelDaySums> {
  try {
    const { results } = await db
      .prepare("SELECT day, count FROM funnel_days WHERE step = ? AND day BETWEEN ? AND ?")
      .bind(step, from, to)
      .all<{ day: string; count: number }>();
    const byDay = new Map(results.map((r) => [r.day, Number(r.count) || 0]));
    const total = results.reduce((sum, r) => sum + (Number(r.count) || 0), 0);
    return { total, byDay };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/no such table/i.test(message)) console.error(`funnel: could not read ${step}`, message);
    return { total: 0, byDay: new Map() };
  }
}
