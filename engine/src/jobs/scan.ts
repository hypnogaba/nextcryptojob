// Щоденний скан вакансій NextCryptoJob (`jobs-scan [--dry]`): крипто-роботодавці з реєстру через
// публічні API їхніх ATS, крипто-дошки (web3.career, JobStash, remote3), крипто-компанії speedrun,
// за бажанням Superteam Earn. Пише лише в базу вакансій NextCryptoJob (db/jobs); насухо не пише нічого.
//
// Ідея прогону перенесена з NextRole (crypto-jobs-agent, scanner: scan-core.ts, dry-scan.ts), але
// без драбини й зростання: реєстр крипто-компаній відомий, і читається він увесь, щодня, без вихідних.
import { randomUUID } from "node:crypto";
import type { FetchOptions } from "../http.js";
import { crawlJob, POSTED_WINDOW_DAYS, type PoolRow } from "../digest/jobs.js";
import { annualRange, isFresh } from "../digest/match.js";
import { ROLE_ORDER } from "../digest/roles.js";
import type { EngineEnv } from "../pipeline/registry.js";
import type { RoleKey } from "../types.js";
import { envFlag, envInt } from "./env.js";
import { type Dropped, prepare, WINDOW_DAYS } from "./prepare.js";
import { mapLimit, runSource } from "./run.js";
import { ATS, atsSourceKey } from "./sources/ats.js";
import { fetchBoard } from "./sources/boards.js";
import { fetchSpeedrunCrypto } from "./sources/speedrun.js";
import { fetchSuperteam, SUPERTEAM_SOURCE } from "./sources/superteam.js";
import type { JobsStore, Registry, SourceChange } from "./store.js";
import type { JobRow, SourceResult, SourceState } from "./types.js";

/** Скільки днів поспіль джерело має падати, щоб стати dead (далі лише щотижнева спроба). */
export const DEAD_AFTER_DAYS = 7;
/** dead пробуємо знову раз на стільки днів. */
export const DEAD_RETRY_DAYS = 7;
/** Частка джерел зі збоєм, від якої прогін partial, а не ok. */
export const PARTIAL_SHARE = 0.2;
/** Скільки джерел читати одночасно; кожен провайдер ще й має свій бюджет (limits.ts). */
const CONCURRENCY = 12;
const DAY_MS = 86_400_000;

export interface ScanDeps {
  store: JobsStore;
  env: EngineEnv;
  now?: Date;
  log?: (line: string) => void;
  /** Для тестів: підставний fetch тощо. */
  fetch?: FetchOptions;
}

/** Що побачила б добірка: ті самі сита й вікна, що engine/src/digest/jobs.ts і match.ts. */
export interface PoolStats {
  /** Живі крипто-вакансії, що пройшли сито добірки (роль у назві, не-крипто компанія). */
  pool: number;
  /** Унікальні за ключем змісту (компанія + назва). */
  unique: number;
  withSalary: number;
  remote: number;
  companies: number;
  byRole: Record<RoleKey, number>;
  byRoleSalary: Record<RoleKey, number>;
}

export interface ScanReport {
  runId: string;
  dry: boolean;
  status: "ok" | "partial" | "failed";
  windowDays: number;
  sources: { total: number; ok: number; failed: number; rateLimited: number; skippedDead: number };
  raw: number;
  kept: number;
  newJobs: number;
  dropped: Dropped;
  bySource: Array<{ source: string; raw: number; kept: number; error?: string }>;
  pool: PoolStats;
  rowsWritten: { estimated: number; measured: number | null };
  /** Рядки, що пішли б (або пішли) у jobs_cache: для --out і перевірок. */
  rows: JobRow[];
}

type Task = { source: string; run: () => Promise<SourceResult> };

const dayOf = (iso: string): string => iso.slice(0, 10);

/**
 * Зміни source_state за результатами. Пишемо лише зміну: здорове джерело без рядка лишається
 * без рядка (0 записів), новий день збою = 1 запис, одужання = 1 запис. 429 нічого не міняє.
 */
export function sourceChanges(results: readonly SourceResult[], prior: ReadonlyMap<string, SourceState>, now: Date): SourceChange[] {
  const at = now.toISOString();
  const out: SourceChange[] = [];
  for (const r of results) {
    const p = prior.get(r.source);
    if (r.ok) {
      if (p) out.push({ source: r.source, kind: "recover" });
      continue;
    }
    if (r.rateLimited) continue;
    if (p && dayOf(p.failedAt) === dayOf(at)) {
      // Той самий день (ручний повтор): день збою не множимо, лише час спроби.
      out.push({ source: r.source, kind: "retry", at });
      continue;
    }
    const failDays = (p?.failDays ?? 0) + 1;
    out.push({ source: r.source, kind: "fail", status: failDays >= DEAD_AFTER_DAYS ? "dead" : "failing",
      failDays, error: r.error ?? "unknown error", at });
  }
  return out;
}

/** dead читаємо лише раз на DEAD_RETRY_DAYS від останньої спроби. */
export function skipToday(state: SourceState | undefined, now: Date): boolean {
  if (!state || state.status !== "dead") return false;
  const checked = Date.parse(state.checkedAt);
  return Number.isFinite(checked) && now.getTime() - checked < DEAD_RETRY_DAYS * DAY_MS;
}

function emptyRoles(): Record<RoleKey, number> {
  return Object.fromEntries(ROLE_ORDER.map((r) => [r, 0])) as Record<RoleKey, number>;
}

/** Рядки скану крізь сито добірки (crawlJob) і її вікно свіжості: скільки людина справді отримає. */
export function poolStats(rows: readonly JobRow[], now: Date): PoolStats {
  const byRole = emptyRoles();
  const byRoleSalary = emptyRoles();
  const unique = new Set<string>();
  const companies = new Set<string>();
  let pool = 0, withSalary = 0, remote = 0;
  for (const r of rows) {
    const row: PoolRow = {
      id: r.id, url: r.url, company: r.company, company_key: r.companyKey, title: r.title, location: r.location,
      remote: r.remote ? 1 : 0, salary_min: r.salaryMin, salary_max: r.salaryMax, salary_currency: r.salaryCurrency,
      tags: JSON.stringify(r.tags), posted_at: r.postedAt, fetched_at: r.fetchedAt, country: null, dedupe_key: r.dedupeKey,
    };
    const x = crawlJob(row);
    if (!("job" in x) || !isFresh(x.job, now)) continue;
    const job = x.job;
    pool++;
    unique.add(job.dedupeKey ?? job.ref);
    companies.add(job.companyKey);
    const paid = annualRange(job.salary) !== null;
    if (paid) withSalary++;
    if (job.remote) remote++;
    for (const role of job.roles) {
      byRole[role]++;
      if (paid) byRoleSalary[role]++;
    }
  }
  return { pool, unique: unique.size, withSalary, remote, companies: companies.size, byRole, byRoleSalary };
}

function tasks(reg: Registry, env: EngineEnv, windowDays: number, now: Date, o: FetchOptions,
               prior: ReadonlyMap<string, SourceState>, skipped: string[]): Task[] {
  const out: Task[] = [];
  const add = (source: string, fn: () => Promise<SourceResult["jobs"]>) => {
    if (skipToday(prior.get(source), now)) { skipped.push(source); return; }
    out.push({ source, run: () => runSource(source, fn) });
  };
  for (const b of reg.boards) {
    if (b.kind === "speedrun") {
      if (envFlag(env, "JOBS_SPEEDRUN", true)) add(b.name, () => fetchSpeedrunCrypto(windowDays, o, now));
    } else {
      add(b.name, () => fetchBoard(b, windowDays, o, now));
    }
  }
  if (envFlag(env, "JOBS_SUPERTEAM", false)) add(SUPERTEAM_SOURCE, () => fetchSuperteam(now, o));
  for (const c of reg.companies) {
    add(atsSourceKey(c.provider, c.atsSlug), () => ATS[c.provider](c.atsSlug, c.name, o));
  }
  return out;
}

export async function runJobsScan(deps: ScanDeps): Promise<ScanReport> {
  const { store, env } = deps;
  const now = deps.now ?? new Date();
  const log = deps.log ?? ((l: string) => console.log(l));
  const windowDays = envInt(env, "JOBS_WINDOW_DAYS", WINDOW_DAYS, 1, 365);
  const runId = `scan_${randomUUID()}`;
  const startedAt = now.toISOString();
  await store.startRun(runId, "scan", startedAt);

  try {
    const reg = await store.loadRegistry();
    const prior = new Map(reg.states.map((s) => [s.source, s]));
    const skipped: string[] = [];
    const list = tasks(reg, env, windowDays, now, deps.fetch ?? {}, prior, skipped);
    log(`jobs-scan${store.dry ? " --dry" : ""}: ${reg.companies.length} companies, ${reg.boards.length} boards, ` +
        `${list.length} sources to read, ${skipped.length} dead skipped, window ${windowDays} d`);

    const results = await mapLimit(list, CONCURRENCY, (t) => t.run());
    const raw = results.flatMap((r) => r.jobs);
    const { rows, dropped } = prepare(raw, windowDays, now);
    const existing = await store.existingIds();
    const newJobs = rows.filter((r) => !existing.has(r.id)).length;

    await store.upsertJobs(rows);
    await store.applySourceChanges(sourceChanges(results, prior, now));

    const keptBy = new Map<string, number>();
    for (const r of rows) keptBy.set(r.source, (keptBy.get(r.source) ?? 0) + 1);
    const bySource = results.map((r) => ({ source: r.source, raw: r.jobs.length, kept: keptBy.get(r.source) ?? 0,
      ...(r.ok ? {} : { error: r.error ?? "unknown error" }) }));
    const failed = results.filter((r) => !r.ok && !r.rateLimited).length;
    const rateLimited = results.filter((r) => r.rateLimited).length;
    const ok = results.length - failed - rateLimited;
    const status: ScanReport["status"] = rows.length === 0 || (results.length > 0 && failed / results.length >= PARTIAL_SHARE)
      ? "partial" : "ok";
    const pool = poolStats(rows, now);

    const notes = {
      window_days: windowDays, raw: raw.length, dropped, skipped_dead: skipped.length,
      pool: { live: pool.pool, unique: pool.unique, with_salary: pool.withSalary, companies: pool.companies },
      boards: bySource.filter((s) => /^(board|aggregator):/.test(s.source)),
      failures: bySource.filter((s) => s.error).slice(0, 40).map((s) => ({ source: s.source, error: s.error })),
    };
    // Два записи прогону входять у сам підсумок: finishRun рахується до виклику.
    const measured = store.measuredRows;
    await store.finishRun(runId, {
      status, sourcesOk: ok, sourcesFailed: failed, jobsFound: rows.length, jobsNew: newJobs,
      rowsWritten: store.dry || measured === null ? null : measured + 1, notes,
    }, new Date().toISOString());

    const report: ScanReport = {
      runId, dry: store.dry, status, windowDays,
      sources: { total: list.length + skipped.length, ok, failed, rateLimited, skippedDead: skipped.length },
      raw: raw.length, kept: rows.length, newJobs, dropped, bySource, pool,
      rowsWritten: { estimated: store.estimatedRows, measured: store.dry ? null : store.measuredRows },
      rows,
    };
    for (const line of formatScanReport(report)) log(line);
    return report;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await store.finishRun(runId, { status: "failed", sourcesOk: 0, sourcesFailed: 0, jobsFound: 0, jobsNew: 0,
      rowsWritten: null, notes: { error: msg.slice(0, 500) } }, new Date().toISOString()).catch(() => undefined);
    throw e;
  }
}

const pct = (n: number, of: number): string => (of ? `${Math.round((100 * n) / of)}%` : "0%");

export function formatScanReport(r: ScanReport): string[] {
  const out = [
    `jobs-scan${r.dry ? " --dry" : ""}: ${r.status}; sources ${r.sources.ok} ok, ${r.sources.failed} failed, ` +
      `${r.sources.rateLimited} rate-limited, ${r.sources.skippedDead} dead skipped`,
    `  jobs: ${r.raw} read, ${r.kept} kept (${r.newJobs} new); dropped: not crypto ${r.dropped.notCrypto}, ` +
      `non-crypto company ${r.dropped.company}, older than ${r.windowDays} d ${r.dropped.old}, broken ${r.dropped.broken}, ` +
      `duplicate ${r.dropped.duplicate}`,
    `  live pool (digest sieve, posted within ${POSTED_WINDOW_DAYS} d): ${r.pool.pool} jobs, ${r.pool.unique} unique, ` +
      `${r.pool.companies} companies, ${r.pool.withSalary} with salary (${pct(r.pool.withSalary, r.pool.pool)}), ${r.pool.remote} remote`,
    `  by role (with salary): ${ROLE_ORDER.filter((k) => r.pool.byRole[k] > 0).map((k) => `${k} ${r.pool.byRole[k]} (${r.pool.byRoleSalary[k]})`).join(", ")}`,
    r.dry
      ? `  D1 rows written if this ran for real: ${r.rowsWritten.estimated} (estimate: 1 per job row, scan_runs 3, source_state 1 per change)`
      : `  D1 rows written: ${r.rowsWritten.measured ?? "unknown"} (estimate ${r.rowsWritten.estimated})`,
  ];
  const top = [...r.bySource].sort((a, b) => b.kept - a.kept).slice(0, 12);
  out.push(`  top sources: ${top.map((s) => `${s.source} ${s.kept}`).join(", ")}`);
  const failures = r.bySource.filter((s) => s.error);
  if (failures.length) {
    out.push(`  failures (${failures.length}): ${failures.slice(0, 15).map((s) => `${s.source}: ${s.error!.slice(0, 80)}`).join(" | ")}`);
  }
  return out;
}
