import { SOURCE_NAME, isSourceKey } from "@/lib/roles/recipes";

/**
 * «Сильні сторони» кандидата в рядку пошуку: два-три джерела ядра ролі з найвищим балом
 * («GitHub 94», «X 71»). Той самий розклад балу, що компанія й так бачить у профілі
 * (breakdownOf у project.ts): лише бали джерел 0–100 і назви джерел, без ніків, адрес і фактів.
 *
 * Лише для кандидатів, яких уже повернув пошук (правило видимості пройдено там), і лише для
 * ролі рядка. Одна інструкція на сторінку результатів.
 */

export type Signal = { label: string; value: number };

type Row = { user_id: string; role: string; breakdown_json: string };

/** Джерела ядра за спаданням балу, без порожніх; не більше `max`. */
export function signalsOf(breakdownJson: string, max = 3): Signal[] {
  let b: unknown;
  try {
    b = JSON.parse(breakdownJson);
  } catch {
    return [];
  }
  const core = b && typeof b === "object" && !Array.isArray(b) ? (b as { core?: unknown }).core : null;
  if (!core || typeof core !== "object" || Array.isArray(core)) return [];
  const out: Signal[] = [];
  for (const [source, part] of Object.entries(core as Record<string, unknown>)) {
    if (!isSourceKey(source) || !part || typeof part !== "object") continue;
    const v = (part as { value?: unknown }).value;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) continue;
    out.push({ label: SOURCE_NAME[source], value: Math.round(Math.min(100, v)) });
  }
  return out.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label)).slice(0, max);
}

/** Сильні сторони для набору (кандидат, роль) одним запитом. Ключ мапи: `${id}:${role}`. */
export async function topSignals(
  db: D1Database,
  items: readonly { id: string; role: string }[],
): Promise<Record<string, Signal[]>> {
  if (items.length === 0) return {};
  const { results } = await db
    .prepare(
      `SELECT s.user_id, s.role, s.breakdown_json FROM scores s
         JOIN json_each(?) j ON s.user_id = json_extract(j.value, '$[0]') AND s.role = json_extract(j.value, '$[1]')`,
    )
    .bind(JSON.stringify(items.map((i) => [i.id, i.role])))
    .all<Row>();
  const out: Record<string, Signal[]> = {};
  for (const r of results) out[`${r.user_id}:${r.role}`] = signalsOf(r.breakdown_json);
  return out;
}

/**
 * Кого з результатів пошуку підписувати: лише рядки з опублікованим балом (бал ролі видно
 * компанії). Неопублікований бал не розкриваємо й через бали джерел.
 */
export function signalItems(page: { data: readonly { candidate_id: string; headline: { role: string; score: number | null } }[] }) {
  return page.data.filter((c) => c.headline.score !== null).map((c) => ({ id: c.candidate_id, role: c.headline.role }));
}
