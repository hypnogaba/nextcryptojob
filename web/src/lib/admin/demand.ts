import type { RoleKey } from "@/lib/card/roles";
import type { JobsDb } from "@/lib/jobs-db";
import { parseRoles, ROLE_NAMES } from "@/lib/jobs/roles";
import { sqlTime } from "@/lib/time";

/**
 * Попит і пропозиція для /admin/demand (власник 17.09: «просто десь збирай, які вакансії у нас
 * є і що люди шукають, щоб ми могли це десь використати»).
 *
 * Дві половини, і навмисно не зведені в одну таблицю:
 *   - що люди шукають: ролі з анкети, свої слова (target_text і role_text), місце, гроші;
 *   - що в нас є: живі вакансії за сферою (тег рядка), віддалено, із зарплатою, де і від кого.
 *
 * Роль людини і сфера вакансії це різні мірки (анкета має 15 ролей, скан пише одну сферу
 * з назви), тож відсотків «покриття» тут немає: це два списки поруч, а не різниця.
 *
 * Ціна: кожен підрахунок читає живі вакансії (кілька тисяч рядків), тож звіт кешується на
 * 10 хвилин, як звіт джерел.
 */

const DAY_MS = 86_400_000;
/** Живою вважаємо вакансію, яку скан бачив за останні стільки днів (як LIVE_WINDOW_DAYS). */
export const DEMAND_LIVE_DAYS = 3;
export const DEMAND_CACHE_TTL_MS = 10 * 60_000;
/** Скільки рядків у кожному списку. */
export const DEMAND_LIST = 12;
/** Скільки свіжих «своїх слів» показуємо. */
export const DEMAND_WORDS = 15;

/** Сфери, як їх пише скан у tags; усе інше показуємо як є. */
export const SPHERE_NAMES: Record<string, string> = {
  engineering: "Engineering",
  operations: "Operations",
  "finance-legal": "Finance and legal",
  product: "Product",
  marketing: "Marketing",
  design: "Design",
  community: "Community",
  security: "Security",
  data: "Data",
  research: "Research",
  sales: "Sales",
  support: "Support",
};

export type Count = { key: string; label: string; n: number };
export type OwnWords = { text: string; kind: "target" | "role"; at: string | null };
export type PayAsk = { currency: string; people: number; median: number };

export interface DemandReport {
  computedAt: number;
  /** Що люди шукають. */
  people: {
    total: number;
    withBrief: number;
    roles: Count[];
    /** remote | city | remote,city | не сказали. */
    places: Count[];
    cities: Count[];
    pay: PayAsk[];
    words: OwnWords[];
  };
  /** Що в нас є. */
  jobs: {
    live: number;
    remote: number;
    withSalary: number;
    companies: number;
    spheres: Count[];
    locations: Count[];
    topCompanies: Count[];
    available: boolean;
    error: string | null;
  };
}

const num = (v: unknown): number => Number(v) || 0;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Медіана цілих чисел (список уже відсортований). */
export function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** Що люди шукають: одна партія запитів до основної бази. */
export async function loadPeopleDemand(db: D1Database): Promise<DemandReport["people"]> {
  const res = await db.batch<Record<string, unknown>>([
    db.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(roles <> '[]'), 0) AS with_brief
         FROM users WHERE is_demo = 0`,
    ),
    db.prepare(`SELECT roles FROM users WHERE is_demo = 0 AND roles <> '[]'`),
    db.prepare(
      `SELECT COALESCE(NULLIF(remote_mode, ''), 'not said') AS key, COUNT(*) AS n
         FROM users WHERE is_demo = 0 GROUP BY key ORDER BY n DESC`,
    ),
    db.prepare(
      `SELECT city AS key, COUNT(*) AS n FROM users
        WHERE is_demo = 0 AND city IS NOT NULL AND city <> '' GROUP BY lower(city) ORDER BY n DESC, key LIMIT ?`,
    ).bind(DEMAND_LIST),
    db.prepare(
      `SELECT COALESCE(NULLIF(salary_currency, ''), 'USD') AS currency, salary_min FROM users
        WHERE is_demo = 0 AND salary_min IS NOT NULL AND salary_min > 0`,
    ),
    db.prepare(
      `SELECT target_text, role_text, created_at FROM users
        WHERE is_demo = 0 AND ((target_text IS NOT NULL AND target_text <> '') OR (role_text IS NOT NULL AND role_text <> ''))
        ORDER BY created_at DESC LIMIT ?`,
    ).bind(DEMAND_WORDS),
  ]);

  const totals = res[0].results[0] ?? {};
  const roleCount = new Map<RoleKey, number>();
  for (const row of res[1].results) {
    for (const role of parseRoles(str(row.roles))) roleCount.set(role, (roleCount.get(role) ?? 0) + 1);
  }
  const byCurrency = new Map<string, number[]>();
  for (const row of res[4].results) {
    const c = str(row.currency).toUpperCase() || "USD";
    const list = byCurrency.get(c) ?? [];
    list.push(num(row.salary_min));
    byCurrency.set(c, list);
  }
  const words: OwnWords[] = [];
  for (const row of res[5].results) {
    const at = typeof row.created_at === "string" ? row.created_at : null;
    if (str(row.target_text).trim()) words.push({ text: str(row.target_text).trim(), kind: "target", at });
    if (str(row.role_text).trim()) words.push({ text: str(row.role_text).trim(), kind: "role", at });
  }

  return {
    total: num(totals.total),
    withBrief: num(totals.with_brief),
    roles: [...roleCount.entries()]
      .map(([key, n]) => ({ key, label: ROLE_NAMES[key], n }))
      .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label)),
    places: res[2].results.map((r) => ({ key: str(r.key), label: placeLabel(str(r.key)), n: num(r.n) })),
    cities: res[3].results.map((r) => ({ key: str(r.key), label: str(r.key), n: num(r.n) })),
    pay: [...byCurrency.entries()]
      .map(([currency, list]) => ({ currency, people: list.length, median: median(list.sort((a, b) => a - b)) }))
      .sort((a, b) => b.people - a.people),
    words: words.slice(0, DEMAND_WORDS),
  };
}

function placeLabel(mode: string): string {
  if (mode === "remote") return "Remote only";
  if (mode === "city") return "One city only";
  if (mode === "remote,city") return "Remote or their city";
  return "Not said yet";
}

/** Що в нас є: живі вакансії з бази вакансій. Помилка не валить сторінку. */
export async function loadJobsSupply(jobs: JobsDb, now: Date): Promise<DemandReport["jobs"]> {
  const from = sqlTime(new Date(now.getTime() - DEMAND_LIVE_DAYS * DAY_MS));
  const empty = {
    live: 0, remote: 0, withSalary: 0, companies: 0, spheres: [] as Count[], locations: [] as Count[], topCompanies: [] as Count[],
  };
  try {
    const [totals] = await jobs.all<Record<string, unknown>>(
      `SELECT COUNT(*) AS live, COALESCE(SUM(remote), 0) AS remote,
              COALESCE(SUM(salary_min IS NOT NULL), 0) AS with_salary, COUNT(DISTINCT company_key) AS companies
         FROM jobs_cache WHERE fetched_at >= ?`,
      from,
    );
    const spheres = await jobs.all<Record<string, unknown>>(
      `SELECT t.value AS key, COUNT(*) AS n FROM jobs_cache j, json_each(j.tags) t
        WHERE j.fetched_at >= ? AND t.value NOT IN ('web3', 'remote')
        GROUP BY t.value ORDER BY n DESC LIMIT ?`,
      from,
      DEMAND_LIST,
    );
    const locations = await jobs.all<Record<string, unknown>>(
      `SELECT location AS key, COUNT(*) AS n FROM jobs_cache
        WHERE fetched_at >= ? AND location IS NOT NULL AND location <> ''
        GROUP BY lower(location) ORDER BY n DESC, key LIMIT ?`,
      from,
      DEMAND_LIST,
    );
    const companies = await jobs.all<Record<string, unknown>>(
      `SELECT company AS key, COUNT(*) AS n FROM jobs_cache WHERE fetched_at >= ?
        GROUP BY company_key ORDER BY n DESC, key LIMIT ?`,
      from,
      DEMAND_LIST,
    );
    const count = (rows: Record<string, unknown>[], names: Record<string, string> = {}): Count[] =>
      rows.map((r) => ({ key: str(r.key), label: names[str(r.key)] ?? str(r.key), n: num(r.n) }));
    return {
      live: num(totals?.live),
      remote: num(totals?.remote),
      withSalary: num(totals?.with_salary),
      companies: num(totals?.companies),
      spheres: count(spheres, SPHERE_NAMES),
      locations: count(locations),
      topCompanies: count(companies),
      available: true,
      error: null,
    };
  } catch (error) {
    return { ...empty, available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function loadDemandReport(db: D1Database, jobs: JobsDb, now: Date = new Date()): Promise<DemandReport> {
  const [people, supply] = await Promise.all([loadPeopleDemand(db), loadJobsSupply(jobs, now)]);
  return { computedAt: now.getTime(), people, jobs: supply };
}

/** Кеш звіту в пам'яті ізоляту, як у звіті джерел: підрахунок читає тисячі рядків. */
let cached: DemandReport | null = null;

export async function cachedDemandReport(
  load: (now: Date) => Promise<DemandReport>,
  now: Date = new Date(),
): Promise<DemandReport> {
  if (cached && now.getTime() - cached.computedAt >= 0 && now.getTime() - cached.computedAt < DEMAND_CACHE_TTL_MS) return cached;
  const report = await load(now);
  cached = report;
  return report;
}

/** Для тестів: забути кеш. */
export function resetDemandCache(): void {
  cached = null;
}
