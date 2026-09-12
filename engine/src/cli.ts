// Командний рядок engine. Облікові дані й ключі беруться з оточення (/etc/nextcryptojob-engine.env).
//
//   node dist/cli.js worker
//   node dist/cli.js score-user <user-id>
//   node dist/cli.js enqueue-refresh [--per-hour N]
//   node dist/cli.js quality-gate <people.json> [raw-cache-dir] [--no-db] [--deadline-ms N]
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { intEnv, startWorker } from "./main.js";
import { DEFAULT_DEADLINE_MS } from "./pipeline/collect.js";
import { type Db, dbFromEnv } from "./pipeline/db.js";
import { shortError } from "./pipeline/errors.js";
import { parseReferencePeople, runQualityGate } from "./pipeline/quality-gate.js";
import { JobQueue } from "./pipeline/queue.js";
import { createRealRegistry } from "./pipeline/realRegistry.js";
import type { CollectorRegistry, EngineEnv } from "./pipeline/registry.js";
import { scoreUser } from "./pipeline/run-person.js";

export const USAGE = `usage: nextcryptojob-engine <command>
  worker                                   run the score_jobs worker until SIGTERM
  score-user <user-id>                     collect and score one person now, print the summary
  enqueue-refresh [--per-hour N]           queue weekly refreshes (hourly timer)
  quality-gate <people.json> [cache-dir]   run the reference set, write quality_runs, exit 1 if the gate fails
      [--no-db]                            do not write quality_runs
      [--deadline-ms N]                    per-person collection deadline (default ENGINE_DEADLINE_MS or 45000)`;

/** Залежності команд: у тестах підставні, у продукті з оточення. */
export interface CliDeps {
  env: EngineEnv;
  db?: () => Db;
  registry?: () => CollectorRegistry;
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

function isEntry(): boolean {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isEntry()) {
  runCli(process.argv.slice(2), { env: process.env }).then((code) => process.exit(code));
}
