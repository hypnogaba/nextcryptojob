// Бал однієї людини: ідентичності → збирачі → формула → один пакет запису в D1.
import type { D1Statement } from "../d1.js";
import { FORMULA_VERSION, scorePerson } from "../formula/score.js";
import type { RoleKey, SourceKey } from "../types.js";
import { collectPerson, DEFAULT_DEADLINE_MS, type Outcomes, partialReason, toPersonFacts } from "./collect.js";
import type { Db } from "./db.js";
import { type CollectorInputs, groupIdentities, withAutoAudits, loadIdentities, plannedSources, selfReportedSources } from "./identities.js";
import type { CollectorRegistry, EngineEnv } from "./registry.js";

/**
 * П.14 (раунд 5, 15.09): перший бал після брифу («Scoring your work…») мав 150 транзакцій Solana,
 * ~26 с найповільніший збирач. Перший, швидкий прохід читає лише FAST_FIRST_PASS_SAMPLE (50-60) і
 * має коротший дедлайн, тож бал з'являється й пишеться в scores за секунди; одразу за ним, тим самим
 * викликом scoreUser, іде звичайний повний прохід (150, повний дедлайн) і переписує той самий рядок.
 * Контракт, який опитує веб (наявність рядка в `scores`), не міняється: другий запис лише уточнює
 * перший, під тим самим user_id/role.
 */
export const FAST_FIRST_PASS_SAMPLE = 55;
export const FAST_FIRST_PASS_DEADLINE_MS = 15_000;

export interface ScoreUserOptions {
  registry: CollectorRegistry;
  db: Db;
  env: EngineEnv;
  /** Зупинка процесу: збір переривається, нічого не пишеться, виклик кидає. */
  signal?: AbortSignal;
  /** Дедлайн на весь збір людини; джерела, що не встигли, стають прогалиною "timeout". */
  deadlineMs?: number;
  /** Годинник формули (вік гаманців), мс. */
  now?: () => number;
  /**
   * П.14: перший, швидкий прохід (менша вибірка Solana, коротший дедлайн) перед звичайним повним.
   * Лише коли хтось справді чекає на перший бал (reason 'connect' у черзі, main.ts): 'refresh' і
   * масові перерахунки цього не роблять, бо подвоюють запити RPC нема кому чекати.
   */
  fastFirstPass?: boolean;
}

export type ScoreSummary = {
  userId: string;
  formula: typeof FORMULA_VERSION;
  totalMs: number;
  collectMs: number;
  /** Мс кожного збирача; `gap` є, якщо джерело не дало фактів. */
  sources: Partial<Record<SourceKey, { ms: number; gap?: string; partial?: number }>>;
  gaps: SourceKey[];
  /** Ролі з балом (не null). */
  scored: number;
  /** Джерела, які людина вписала сама, без підтвердження (модель довіри 13.09). */
  selfReported: SourceKey[];
};

/**
 * v7: скільки посилань на роботи людина додала (profile_prefs.links_json, веб). Лише кількість, без
 * перевірки (власник 17.09, п.4). Таблиці ще немає (старі бази, тести): 0.
 */
export async function loadLinkCount(db: Db, userId: string): Promise<number> {
  let rows: { links_json: string | null }[];
  try {
    rows = await db.query<{ links_json: string | null }>("SELECT links_json FROM profile_prefs WHERE user_id = ?", [userId]);
  } catch (e) {
    if (e instanceof Error && /no such table/i.test(e.message)) return 0;
    throw e;
  }
  try {
    const list = JSON.parse(rows[0]?.links_json ?? "[]") as unknown;
    return Array.isArray(list) ? list.filter((l) => l && typeof (l as { url?: unknown }).url === "string").length : 0;
  } catch {
    return 0;
  }
}

const UPSERT_FACTS =
  "INSERT INTO source_facts (user_id, source, facts_json, gap_reason, fetched_at) VALUES (?, ?, ?, ?, datetime('now')) " +
  "ON CONFLICT (user_id, source) DO UPDATE SET facts_json = excluded.facts_json, gap_reason = excluded.gap_reason, " +
  "fetched_at = excluded.fetched_at";

const UPSERT_SCORE =
  "INSERT INTO scores (user_id, role, score, core, cover, breakdown_json, formula_version, computed_at) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now')) " +
  "ON CONFLICT (user_id, role) DO UPDATE SET score = excluded.score, core = excluded.core, cover = excluded.cover, " +
  "breakdown_json = excluded.breakdown_json, formula_version = excluded.formula_version, computed_at = excluded.computed_at";

/**
 * Один прохід: зібрати факти людини й перерахувати бал, записати один пакетом (одна транзакція D1):
 * рядки `source_facts` для кожного доречного джерела (факти або NULL і `gap_reason`; часткова
 * відповідь гаманців: факти і `gap_reason` "partial: …"), видалення рядків джерел, яких людина вже
 * не має, і `scores` за всіма ролями. Або все, або нічого: половини запису після збою не буває.
 * Виніс з scoreUser для двопрохідного першого балу (FAST_FIRST_PASS_*, п.14): обидва проходи пишуть
 * тим самим кодом у ті самі рядки, другий переписує перший.
 */
async function collectScoreWrite(
  userId: string, inputs: CollectorInputs, db: Db, linkCount: number,
  collectOpts: { registry: CollectorRegistry; env: EngineEnv; deadlineMs: number; signal?: AbortSignal; now?: () => number },
): Promise<{ outcomes: Outcomes; collectMs: number; scoredRoles: number }> {
  const { outcomes, ms: collectMs } = await collectPerson(inputs, collectOpts);
  collectOpts.signal?.throwIfAborted();

  const facts = { ...toPersonFacts(outcomes), links: linkCount > 0 ? { count: linkCount } : null };
  const result = scorePerson(facts, (collectOpts.now ?? Date.now)());
  const planned = plannedSources(inputs);

  const statements: D1Statement[] = [];
  statements.push(planned.length
    ? { sql: `DELETE FROM source_facts WHERE user_id = ? AND source NOT IN (${planned.map(() => "?").join(", ")})`,
        params: [userId, ...planned] }
    : { sql: "DELETE FROM source_facts WHERE user_id = ?", params: [userId] });
  for (const source of planned) {
    const { result: r, partial } = outcomes[source]!;
    // Часткова відповідь: факти пишуться, а адреси без відповіді чи з невідомим видно в gap_reason.
    statements.push({ sql: UPSERT_FACTS,
      params: [userId, source, r.ok ? JSON.stringify(r.facts) : null, r.ok ? partialReason(partial) : r.gap] });
  }
  for (const [role, rr] of Object.entries(result.roles) as Array<[RoleKey, (typeof result.roles)[RoleKey]]>) {
    statements.push({ sql: UPSERT_SCORE,
      params: [userId, role, rr.score, rr.core, rr.cover, JSON.stringify(rr.breakdown), result.formula] });
  }
  // UPSERT і DELETE без приростів: повтор після загубленої відповіді дає той самий стан.
  await db.batch(statements, { idempotent: true });

  return { outcomes, collectMs, scoredRoles: Object.values(result.roles).filter((r) => r.score !== null).length };
}

/**
 * Зібрати факти людини й перерахувати бал; тим самим кодом, що описано в collectScoreWrite.
 *
 * `o.fastFirstPass` (п.14, 15.09): перший, швидкий прохід (FAST_FIRST_PASS_SAMPLE транзакцій
 * Solana замість повних, дедлайн FAST_FIRST_PASS_DEADLINE_MS) пише бал у ті самі рядки одразу,
 * тож людина, що чекає першого балу, бачить його за секунди, а не за ~26 с найповільнішого
 * збирача. Одразу за ним, тим самим викликом, іде звичайний повний прохід і переписує той самий
 * рядок точнішим числом. Помилка чи дедлайн першого проходу не валить другий: перший лише
 * пришвидшує появу балу, другий лишається джерелом правди. Зовнішню зупинку (signal) обидва
 * проходи кидають як є: переривати процес мовчки не можна.
 */
export async function scoreUser(userId: string, o: ScoreUserOptions): Promise<ScoreSummary> {
  const t0 = performance.now();
  const inputs = withAutoAudits(groupIdentities(await loadIdentities(o.db, userId)));
  const linkCount = await loadLinkCount(o.db, userId);
  const deadlineMs = o.deadlineMs ?? DEFAULT_DEADLINE_MS;

  if (o.fastFirstPass) {
    try {
      await collectScoreWrite(userId, inputs, o.db, linkCount, {
        registry: o.registry, env: { ...o.env, SOL_SAMPLE: String(FAST_FIRST_PASS_SAMPLE) },
        deadlineMs: Math.min(deadlineMs, FAST_FIRST_PASS_DEADLINE_MS),
        ...(o.signal ? { signal: o.signal } : {}), ...(o.now ? { now: o.now } : {}),
      });
    } catch (e) {
      if (o.signal?.aborted) throw e; // зупинку процесу не ковтаємо
      // Перший прохід міг не встигнути чи спіткнутись (RPC, дедлайн): другий, повний, однаково пише.
    }
  }

  const { outcomes, collectMs, scoredRoles } = await collectScoreWrite(userId, inputs, o.db, linkCount, {
    registry: o.registry, env: o.env, deadlineMs, ...(o.signal ? { signal: o.signal } : {}), ...(o.now ? { now: o.now } : {}),
  });

  return summarize(userId, outcomes, collectMs, Math.round(performance.now() - t0), scoredRoles, selfReportedSources(inputs));
}

function summarize(userId: string, outcomes: Outcomes, collectMs: number, totalMs: number, scored: number,
  selfReported: SourceKey[]): ScoreSummary {
  const sources: ScoreSummary["sources"] = {};
  const gaps: SourceKey[] = [];
  for (const [source, out] of Object.entries(outcomes) as Array<[SourceKey, NonNullable<Outcomes[SourceKey]>]>) {
    sources[source] = {
      ms: out.ms,
      ...(out.result.ok ? {} : { gap: out.result.gap }),
      ...(out.partial ? { partial: Object.keys(out.partial).length } : {}),
    };
    if (!out.result.ok) gaps.push(source);
  }
  return { userId, formula: FORMULA_VERSION, totalMs, collectMs, sources, gaps, scored, selfReported };
}
