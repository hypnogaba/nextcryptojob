// Командний рядок engine. Облікові дані й ключі беруться з оточення (/etc/nextcryptojob-engine.env).
//
//   node dist/cli.js worker
//   node dist/cli.js score-user <user-id>
//   node dist/cli.js enqueue-refresh [--per-hour N]
//   node dist/cli.js quality-gate <people.json> [raw-cache-dir] [--no-db] [--deadline-ms N]
//   node dist/cli.js score-facts --x <h> --github <l> --site <url> --evm <a,...> --solana <a,...> [--sherlock <h>]
//   node dist/cli.js digest-due [--dry-run [--user <id> | --profile <json>]]
import { readFileSync, realpathSync } from "node:fs";
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
import { scoreUser } from "./pipeline/run-person.js";
import { formatScoreFacts, type ScoreFactsArgs, scoreFacts } from "./pipeline/score-facts.js";

export const USAGE = `usage: nextcryptojob-engine <command>
  worker                                   run the score_jobs worker until SIGTERM
  score-user <user-id>                     collect and score one person now, print the summary
  enqueue-refresh [--per-hour N]           queue weekly refreshes (hourly timer)
  quality-gate <people.json> [cache-dir]   run the reference set, write quality_runs, exit 1 if the gate fails
      [--no-db]                            do not write quality_runs
      [--deadline-ms N]                    per-person collection deadline (default ENGINE_DEADLINE_MS or 45000)
  score-facts [--x h] [--github l] [--youtube h] [--site url] [--evm a,b] [--solana a,b] [--sherlock h]
      [--json] [--deadline-ms N]           collect and score identities given here, without D1; X and GitHub
                                           count as verified (run it only for people who agreed)
  digest-due                               send daily job digests to people whose hour it is (hourly timer)
      [--dry-run]                          pick the jobs and print them; write nothing, send nothing
      [--user <id>]                        with --dry-run: this person, whatever the hour
      [--profile <json>]                   with --dry-run: a made-up profile, e.g.
                                           '{"roles":["engineer"],"remote_mode":"remote,city","city":"Paris"}'`;

/** Залежності команд: у тестах підставні, у продукті з оточення. */
export interface CliDeps {
  env: EngineEnv;
  db?: () => Db;
  registry?: () => CollectorRegistry;
  /** База вакансій NextRole (лише читання). */
  jobs?: () => JobsDb;
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
        if (args.length) { err(USAGE); return 2; }
        const r = await new JobQueue(db()).enqueueRefresh(perHour === undefined ? {} : { perHour });
        out(`enqueue-refresh: ${r.enqueued} queued (hourly budget left ${r.budget})`);
        return 0;
      }
      case "quality-gate": {
        const noDb = has(args, "--no-db");
        const deadlineMs = posInt(flag(args, "--deadline-ms"), "--deadline-ms")
          ?? intEnv(deps.env, "ENGINE_DEADLINE_MS", DEFAULT_DEADLINE_MS);
        const [peoplePath, cacheDir, ...rest] = args;
        if (!peoplePath || rest.length) { err(USAGE); return 2; }
        let json: unknown;
        // Без тексту помилки JSON.parse: він цитує шматок файлу, а там реальні люди.
        try { json = JSON.parse(readFileSync(peoplePath, "utf8")); } catch { err(`quality-gate: ${peoplePath} не читається як JSON`); return 2; }
        const people = parseReferencePeople(json);
        const report = await runQualityGate(people, {
          registry: registry(), env: deps.env, deadlineMs, cacheDir: cacheDir ?? null, db: noDb ? null : db(),
          concurrency: intEnv(deps.env, "ENGINE_CONCURRENCY", 3), log: out,
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
