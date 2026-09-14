// Командний рядок engine. Облікові дані й ключі беруться з оточення (/etc/nextcryptojob-engine.env).
//
//   node dist/cli.js worker
//   node dist/cli.js score-user <user-id>
//   node dist/cli.js enqueue-refresh [--per-hour N] [--stale-formula]
//   node dist/cli.js quality-gate <people.json> [raw-cache-dir] [--no-db] [--cache-only] [--note <text>] [--deadline-ms N]
//   node dist/cli.js score-facts --x <h> --github <l> --site <url> --evm <a,...> --solana <a,...> [--sherlock <h>]
//   node dist/cli.js digest-due [--dry-run [--user <id> | --profile <json>]]
//   node dist/cli.js jobs-scan [--dry] [--registry <file>] [--out <file>]
//   node dist/cli.js jobs-discover [--dry] [--out <file>]
//   node dist/cli.js jobs-about [--dry]
//   node dist/cli.js jobs-prune [--dry] [--days N]
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { jobsDbFromEnv, type JobsDb } from "./digest/jobs-db.js";
import type { DigestProfile } from "./digest/match.js";
import { parseRoles } from "./digest/roles.js";
import { formatDryRun, runDigestDue } from "./digest/schedule.js";
import { intEnv, startWorker } from "./main.js";
import { DEFAULT_DEADLINE_MS } from "./pipeline/collect.js";
import { type Db, dbFromEnv } from "./pipeline/db.js";
import { shortError } from "./pipeline/errors.js";
import { parseReferencePeople, runQualityGate } from "./pipeline/quality-gate.js";
import { JobQueue } from "./pipeline/queue.js";
import { createRealRegistry } from "./pipeline/realRegistry.js";
import type { CollectorRegistry, EngineEnv } from "./pipeline/registry.js";
import { FORMULA_VERSION } from "./formula/score.js";
import { scoreUser } from "./pipeline/run-person.js";
import { formatScoreFacts, type ScoreFactsArgs, scoreFacts } from "./pipeline/score-facts.js";
import { runCompanyAbout } from "./jobs/about.js";
import { runJobsDiscover } from "./jobs/discover.js";
import { JOBS_DB_ENV, jobsD1FromEnv } from "./jobs/env.js";
import { runJobsPrune } from "./jobs/prune.js";
import { runJobsScan } from "./jobs/scan.js";
import { loadSeed, SEED_PATH } from "./jobs/seed.js";
import { type JobsBackend, JobsStore } from "./jobs/store.js";

export const USAGE = `usage: nextcryptojob-engine <command>
  worker                                   run the score_jobs worker until SIGTERM
  score-user <user-id>                     collect and score one person now, print the summary
  enqueue-refresh [--per-hour N]           queue weekly refreshes (hourly timer)
      [--stale-formula]                    instead: queue everyone with a score from another formula
                                           version, whatever the age of the facts (--per-hour N = at most N)
  quality-gate <people.json> [cache-dir]   run the reference set, write quality_runs, exit 1 if the gate fails
                                           (gate: within one band >= 85%; 2-band misses are reported, not a rule)
      [--no-db]                            do not write quality_runs
      [--cache-only]                       use only cache-dir; fail before collecting if any source is missing
      [--note <text>]                      label the run (stored in report_json.note, up to 200 characters)
      [--deadline-ms N]                    per-person collection deadline (default ENGINE_DEADLINE_MS or 45000)
  score-facts [--x h] [--github l] [--youtube h] [--site url] [--evm a,b] [--solana a,b] [--sherlock h]
      [--json] [--deadline-ms N]           collect and score identities given here, without D1; X and GitHub
                                           count as verified (run it only for people who agreed)
  digest-due                               send daily job digests to people whose hour it is (hourly timer)
      [--dry-run]                          pick the jobs and print them; write nothing, send nothing
      [--user <id>]                        with --dry-run: this person, whatever the hour
      [--profile <json>]                   with --dry-run: a made-up profile, e.g.
                                           '{"roles":["engineer"],"remote_mode":"remote,city","city":"Paris"}'
  jobs-scan                                read every crypto job source, write the jobs DB (daily timer)
      [--dry]                              read the sources, write nothing, print what would be written
      [--registry <file>]                  with --dry and no CF_JOBS_D1_DATABASE_ID: companies and boards from
                                           this JSON (default db/jobs/seed/registry.json)
      [--out <file>]                       also write the report and the rows as JSON
  jobs-discover [--dry] [--out <file>]     add new crypto companies with a public ATS to the registry (weekly)
                                           (then jobs-about for the whole registry)
  jobs-about [--dry]                       fill a missing company domain and a one or two sentence "about" from
                                           the registry note, job links, Greenhouse, Workable and speedrun
  jobs-prune [--dry] [--days N]            delete jobs the scan has not seen for N days (default 30; weekly)`;

/** Залежності команд: у тестах підставні, у продукті з оточення. */
export interface CliDeps {
  env: EngineEnv;
  db?: () => Db;
  registry?: () => CollectorRegistry;
  /** База вакансій NextCryptoJob для добірки (лише читання). */
  jobs?: () => JobsDb;
  /** База вакансій для сканера (запис); без неї CF_JOBS_D1_DATABASE_ID. */
  jobsBackend?: () => JobsBackend;
  fetchImpl?: typeof fetch;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`${name} потребує значення`);
  args.splice(i, 2);
  return v;
}

function has(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
}

function posInt(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} має бути цілим ≥ 1`);
  return n;
}

/** Виконує команду й повертає код виходу (0 успіх, 1 провал воріт чи збій, 2 неправильний виклик). */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const db = deps.db ?? (() => dbFromEnv(deps.env));
  const registry = deps.registry ?? createRealRegistry;
  const args = [...argv];
  const cmd = args.shift();

  try {
    switch (cmd) {
      case "worker": {
        await startWorker(deps.env, deps.registry?.());
        return 0;
      }
      case "score-user": {
        const userId = args[0];
        if (!userId || args.length !== 1) { err(USAGE); return 2; }
        const summary = await scoreUser(userId, { registry: registry(), db: db(), env: deps.env,
          deadlineMs: intEnv(deps.env, "ENGINE_DEADLINE_MS", DEFAULT_DEADLINE_MS) });
        out(JSON.stringify(summary, null, 2));
        return 0;
      }
      case "enqueue-refresh": {
        const perHour = posInt(flag(args, "--per-hour"), "--per-hour");
        const staleFormula = has(args, "--stale-formula");
        if (args.length) { err(USAGE); return 2; }
        if (staleFormula) {
          const r = await new JobQueue(db()).enqueueFormulaRefresh(FORMULA_VERSION, perHour === undefined ? {} : { limit: perHour });
          out(`enqueue-refresh: ${r.enqueued} queued with scores from a formula other than ${FORMULA_VERSION}`);
          return 0;
        }
        const r = await new JobQueue(db()).enqueueRefresh(perHour === undefined ? {} : { perHour });
        out(`enqueue-refresh: ${r.enqueued} queued (hourly budget left ${r.budget})`);
        return 0;
      }
      case "quality-gate": {
        const noDb = has(args, "--no-db");
        const cacheOnly = has(args, "--cache-only");
        const note = flag(args, "--note")?.trim() || null;
        if (note && note.length > 200) { err("quality-gate: --note longer than 200 characters"); return 2; }
        const deadlineMs = posInt(flag(args, "--deadline-ms"), "--deadline-ms")
          ?? intEnv(deps.env, "ENGINE_DEADLINE_MS", DEFAULT_DEADLINE_MS);
        const [peoplePath, cacheDir, ...rest] = args;
        if (!peoplePath || rest.length || (cacheOnly && !cacheDir)) { err(USAGE); return 2; }
        let json: unknown;
        // Без тексту помилки JSON.parse: він цитує шматок файлу, а там реальні люди.
        try { json = JSON.parse(readFileSync(peoplePath, "utf8")); } catch { err(`quality-gate: ${peoplePath} не читається як JSON`); return 2; }
        const people = parseReferencePeople(json);
        const report = await runQualityGate(people, {
          registry: registry(), env: deps.env, deadlineMs, cacheDir: cacheDir ?? null, db: noDb ? null : db(),
          concurrency: intEnv(deps.env, "ENGINE_CONCURRENCY", 3), log: out, cacheOnly, note,
        });
        return report.passed ? 0 : 1;
      }
      case "score-facts": {
        const deadlineMs = posInt(flag(args, "--deadline-ms"), "--deadline-ms")
          ?? intEnv(deps.env, "ENGINE_DEADLINE_MS", DEFAULT_DEADLINE_MS);
        const json = has(args, "--json");
        const csv = (v: string | undefined): string[] => (v ?? "").split(",").map((a) => a.trim()).filter(Boolean);
        const a: ScoreFactsArgs = {
          x: flag(args, "--x") ?? null, github: flag(args, "--github") ?? null, youtube: flag(args, "--youtube") ?? null,
          site: flag(args, "--site") ?? null, evm: csv(flag(args, "--evm")), solana: csv(flag(args, "--solana")),
          sherlock: flag(args, "--sherlock") ?? null,
        };
        const none = !a.x && !a.github && !a.youtube && !a.site && !a.evm!.length && !a.solana!.length && !a.sherlock;
        if (args.length || none) { err(USAGE); return 2; }
        const r = await scoreFacts(a, { registry: registry(), env: deps.env, deadlineMs });
        if (json) {
          out(JSON.stringify({ collectMs: r.collectMs, outcomes: r.outcomes, sources: r.score.sources,
            roles: Object.fromEntries(Object.entries(r.score.roles).map(([k, v]) => [k, { score: v.score, level: v.level, cover: v.cover,
              reason: v.breakdown.reason }])), gaps: r.score.roles.engineer.breakdown.gaps }, null, 2));
        } else {
          for (const line of formatScoreFacts(r, deps.env, deadlineMs)) out(line);
        }
        return 0;
      }
      case "digest-due": {
        const dryRun = has(args, "--dry-run");
        const userId = flag(args, "--user");
        const profileJson = flag(args, "--profile");
        if (args.length || ((userId || profileJson) && !dryRun) || (userId && profileJson)) { err(USAGE); return 2; }
        const profile = profileJson === undefined ? undefined : parseProfile(profileJson);
        // Вигаданому профілю наша база потрібна лише для вакансій компаній; без неї обходиться.
        const ourDb = profile && !deps.env.CF_D1_DATABASE_ID && !deps.db ? null : db();
        const summary = await runDigestDue(
          { db: ourDb, jobs: (deps.jobs ?? (() => jobsDbFromEnv(deps.env)))(), env: deps.env, fetchImpl: deps.fetchImpl, log: out },
          { dryRun, userId, profile });
        if (dryRun) for (const line of formatDryRun(summary)) out(line);
        return summary.failed > 0 && !dryRun ? 1 : 0;
      }
      case "jobs-scan": {
        const dry = has(args, "--dry");
        const registry = flag(args, "--registry");
        const outFile = flag(args, "--out");
        if (args.length || (registry && !dry)) { err(USAGE); return 2; }
        const store = jobsStore(deps, dry, registry);
        const report = await runJobsScan({ store, env: deps.env, log: out, fetch: deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : undefined });
        if (outFile) writeFileSync(outFile, JSON.stringify(report, null, 1));
        return 0;
      }
      case "jobs-discover": {
        const dry = has(args, "--dry");
        const outFile = flag(args, "--out");
        if (args.length) { err(USAGE); return 2; }
        const fetch = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : undefined;
        const report = await runJobsDiscover({ store: jobsStore(deps, dry), env: deps.env, log: out, fetch });
        if (outFile) writeFileSync(outFile, JSON.stringify(report, null, 1));
        // Нові роботодавці одразу отримують домен і опис. Збій тут результату розвідки не міняє.
        try {
          await runCompanyAbout({ store: jobsStore(deps, dry), env: deps.env, log: out, fetch });
        } catch (e) {
          out(`jobs-about after jobs-discover failed: ${shortError(e, 300)}`);
        }
        return 0;
      }
      case "jobs-about": {
        const dry = has(args, "--dry");
        if (args.length) { err(USAGE); return 2; }
        await runCompanyAbout({ store: jobsStore(deps, dry), env: deps.env, log: out,
          fetch: deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : undefined });
        return 0;
      }
      case "jobs-prune": {
        const dry = has(args, "--dry");
        const days = posInt(flag(args, "--days"), "--days");
        if (args.length) { err(USAGE); return 2; }
        await runJobsPrune({ store: jobsStore(deps, dry), env: deps.env, days, log: out });
        return 0;
      }
      case undefined: case "help": case "--help": case "-h":
        out(USAGE);
        return cmd === undefined ? 2 : 0;
      default:
        err(`unknown command: ${cmd}\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    err(`${cmd}: ${shortError(e, 400)}`);
    return 1;
  }
}

/**
 * Сховище сканера. З CF_JOBS_D1_DATABASE_ID: база вакансій (насухо лише SELECT). Без неї можна лише
 * насухо, і тоді реєстр з засіву (db/jobs/seed/registry.json або --registry).
 */
function jobsStore(deps: CliDeps, dry: boolean, registry?: string): JobsStore {
  if (deps.jobsBackend) return new JobsStore(deps.jobsBackend(), dry);
  if (deps.env[JOBS_DB_ENV]?.trim() && !registry) return new JobsStore(jobsD1FromEnv(deps.env), dry);
  if (!dry) throw new Error(`немає ${JOBS_DB_ENV}: без бази вакансій можна лише --dry`);
  return new JobsStore(null, true, loadSeed(registry ?? SEED_PATH));
}

/** --profile для сухого прогону: ролі й місце як у users (docs/contracts.md §1). */
function parseProfile(json: string): DigestProfile {
  let v: Record<string, unknown>;
  try { v = JSON.parse(json) as Record<string, unknown>; } catch { throw new Error("--profile має бути JSON"); }
  const roles = parseRoles(JSON.stringify(v.roles ?? []));
  if (!roles.length) throw new Error("--profile: roles має містити хоч один ключ ролі з docs/contracts.md §1");
  const str = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : null);
  const salary = typeof v.salary_min === "number" && Number.isFinite(v.salary_min) ? v.salary_min : null;
  return { roles, remoteMode: str(v.remote_mode) ?? "remote", city: str(v.city), salaryMin: salary, salaryCurrency: str(v.salary_currency) };
}

function isEntry(): boolean {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isEntry()) {
  runCli(process.argv.slice(2), { env: process.env }).then((code) => process.exit(code));
}
