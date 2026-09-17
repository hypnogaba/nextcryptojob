import type { JobsDb } from "@/lib/jobs-db";
import { parseDbTime } from "./job-sources";

/**
 * Адмінка, /admin/sources: дошки екосистем і фондів (job_boards у базі вакансій, db/jobs 0003)
 * і джерела, що падають (source_state). Лише читання, через jobsDb.
 *
 * Як це працює (engine/src/jobs/discover.ts): вакансій з дошок ми не беремо. Раз на тиждень
 * (неділя 05:30 UTC) розвідка читає СПИСОК КОМПАНІЙ дошки з рішенням 'discover' (платформа Getro)
 * і для компанії, якої реєстр ще не знає, одну сторінку її вакансій, звідки бере лише адресу
 * її ATS. Нова дошка ATS, що відповіла своїм API, іде в реєстр компаній (companies,
 * discovered_via = 'getro:<id колекції>'), і далі щоденний скан читає вакансії прямо з ATS.
 * 'manual': платформа забороняє збір, компанії портфеля додано руками ('portfolio:<slug>').
 * 'skip': не читаємо (причина в reason).
 */

export type Board = {
  slug: string;
  label: string;
  kind: string;
  url: string | null;
  platform: string;
  decision: "discover" | "skip" | "manual";
  reason: string | null;
  /** Компаній на дошці, коли її перевіряли руками (checked_at). */
  listed: number | null;
  checkedAt: string | null;
  /** Роботодавців у реєстрі, доданих з цієї дошки, і з них увімкнених. */
  added: number;
  enabled: number;
  /** Остання розвідка по цій дошці (з нотаток прогону), якщо була. */
  lastRun: { companies: number; withJobs: number; added: number; known: number; hostedOnly: number; error: string | null } | null;
};

export type DiscoveryRun = { at: number; status: string; added: number; getroEnabled: boolean } | null;

export type FailingSource = {
  source: string;
  status: "failing" | "dead";
  failDays: number;
  lastError: string | null;
  failedAt: number | null;
  checkedAt: number | null;
};

export type BoardsReport = { boards: Board[]; discovery: DiscoveryRun; failing: FailingSource[] };

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v) || 0;
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

/** Звідки роботодавець у реєстрі: так discover.ts пише companies.discovered_via для дошки. */
export function boardVia(b: { slug: string; platform: string; platform_id?: string | null }): string {
  return b.platform === "getro" && b.platform_id ? `getro:${b.platform_id}` : `portfolio:${b.slug}`;
}

type GetroNote = {
  board?: string;
  id?: number;
  companies?: number;
  withJobs?: number;
  added?: number;
  known?: number;
  hostedOnly?: number;
  error?: string;
};

/** Чотири запити до бази вакансій паралельно: дошки, лічильники реєстру, остання розвідка, збої джерел. */
export async function loadBoardsReport(jobs: JobsDb): Promise<BoardsReport> {
  const [boards, counts, runs, failing] = await Promise.all([
    jobs.all<Row>(
      `SELECT slug, label, kind, url, platform, platform_id, companies, decision, reason, checked_at
         FROM job_boards ORDER BY CASE decision WHEN 'discover' THEN 0 WHEN 'manual' THEN 1 ELSE 2 END, label`,
    ),
    jobs.all<Row>(
      `SELECT discovered_via AS via, COUNT(*) AS n, SUM(enabled) AS enabled FROM companies
        WHERE discovered_via LIKE 'getro:%' OR discovered_via LIKE 'portfolio:%' GROUP BY discovered_via`,
    ),
    jobs.all<Row>(
      `SELECT started_at, status, jobs_new, notes FROM scan_runs WHERE kind = 'discover' ORDER BY started_at DESC LIMIT 1`,
    ),
    jobs.all<Row>(
      `SELECT source, status, fail_days, last_error, failed_at, checked_at FROM source_state
        ORDER BY status = 'dead' DESC, fail_days DESC, source LIMIT 200`,
    ),
  ]);

  const byVia = new Map(counts.map((c) => [String(c.via), { n: num(c.n), enabled: num(c.enabled) }]));
  const run = runs[0];
  let notes: { getro?: GetroNote[] | null } = {};
  try {
    notes = JSON.parse(String(run?.notes ?? "{}")) as typeof notes;
  } catch {
    // Нотатки прогону обрізано чи не JSON: без подробиць по дошках.
  }
  const perBoard = new Map((notes.getro ?? []).map((g) => [String(g.board ?? ""), g]));

  return {
    boards: boards.map((b) => {
      const via = boardVia({ slug: String(b.slug), platform: String(b.platform), platform_id: text(b.platform_id) });
      const c = byVia.get(via) ?? { n: 0, enabled: 0 };
      const g = perBoard.get(String(b.slug));
      return {
        slug: String(b.slug),
        label: String(b.label),
        kind: String(b.kind),
        url: text(b.url),
        platform: String(b.platform),
        decision: (["discover", "skip", "manual"].includes(String(b.decision)) ? b.decision : "skip") as Board["decision"],
        reason: text(b.reason),
        listed: b.companies === null || b.companies === undefined ? null : num(b.companies),
        checkedAt: text(b.checked_at),
        added: c.n,
        enabled: c.enabled,
        lastRun: g
          ? {
              companies: num(g.companies),
              withJobs: num(g.withJobs),
              added: num(g.added),
              known: num(g.known),
              hostedOnly: num(g.hostedOnly),
              error: text(g.error),
            }
          : null,
      };
    }),
    discovery: run
      ? {
          at: parseDbTime(String(run.started_at)) ?? 0,
          status: String(run.status),
          added: num(run.jobs_new),
          getroEnabled: Array.isArray(notes.getro),
        }
      : null,
    failing: failing.map((f) => ({
      source: String(f.source),
      status: f.status === "dead" ? "dead" : "failing",
      failDays: num(f.fail_days),
      lastError: text(f.last_error),
      failedAt: parseDbTime(text(f.failed_at)),
      checkedAt: parseDbTime(text(f.checked_at)),
    })),
  };
}

/** Що робити з джерелом, що падає: одним реченням для адміна. */
export function failingAdvice(f: Pick<FailingSource, "status" | "failDays" | "lastError">): string {
  const err = (f.lastError ?? "").toLowerCase();
  if (f.status === "dead") {
    return "Dead: read once a week only. Open the board link; if the company moved to another ATS or stopped hiring, change or disable it in the jobs registry.";
  }
  if (/\b404\b|not found|gone|410/.test(err)) {
    return "The board answers 404: the company probably moved its jobs page. Find the new ATS link and update the registry.";
  }
  if (/\b(429|rate)/.test(err)) return "Rate limited: nothing to do, it retries tomorrow.";
  if (/timeout|timed out|abort|network|fetch failed|5\d\d/.test(err)) {
    return f.failDays >= 3 ? "Timeouts for several days: open the board link to see if the site is down." : "Timeout or server error: usually heals by itself.";
  }
  return f.failDays >= 3 ? "Failing for several days: open the board link and check the error." : "One or two failed scans: watch it, nothing to do yet.";
}

/**
 * Поріг «малого» джерела на /admin/sources: менше стількох живих вакансій = згорнуто
 * (власник 17.09: «все, що нижче 50 вакансій, не показуй, десь заховай»).
 */
export const SMALL_SOURCE_JOBS = 50;
