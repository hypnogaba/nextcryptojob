// Worker черги score_jobs: кожні 3 с бере завдання (до ENGINE_CONCURRENCY людей одночасно),
// рахує бал, ставить done або failed; раз на хвилину повертає завислі. SIGTERM: нових не бере,
// дає поточним закінчитись, а що не встигло, повертає в чергу без втраченої спроби.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_DEADLINE_MS } from "./pipeline/collect.js";
import { type Db, dbFromEnv } from "./pipeline/db.js";
import { shortError } from "./pipeline/errors.js";
import { type ClaimedJob, JobQueue, type QueueOptions } from "./pipeline/queue.js";
import { createRealRegistry } from "./pipeline/realRegistry.js";
import type { CollectorRegistry, EngineEnv } from "./pipeline/registry.js";
import { scoreUser } from "./pipeline/run-person.js";

export const DEFAULT_CONCURRENCY = 3;
export const DEFAULT_POLL_MS = 3_000;
export const DEFAULT_SWEEP_EVERY_MS = 60_000;
/** Скільки чекати поточні завдання після SIGTERM: дедлайн збору плюс запис. */
export const DEFAULT_GRACE_MS = 60_000;

export interface WorkerOptions {
  db: Db;
  registry: CollectorRegistry;
  env: EngineEnv;
  /** Перший SIGTERM: нових завдань не брати, поточним дати закінчитись. */
  stop: AbortSignal;
  /** Другий SIGTERM або кінець терпіння: перервати поточні й повернути їх у чергу. */
  hardStop?: AbortSignal;
  concurrency?: number;
  pollMs?: number;
  sweepEveryMs?: number;
  deadlineMs?: number;
  graceMs?: number;
  queue?: QueueOptions;
  log?: (line: string) => void;
}

export type WorkerStats = { done: number; failed: number; retried: number; requeued: number };

/** Префікс id людини для журналу: досить, щоб знайти рядок, і нічого про саму людину. */
export const idPrefix = (userId: string): string => userId.slice(0, 8);

const delay = (ms: number, ...signals: Array<AbortSignal | undefined>): Promise<void> => new Promise((resolve) => {
  const live = signals.filter((s): s is AbortSignal => !!s);
  const done = () => { clearTimeout(t); for (const s of live) s.removeEventListener("abort", done); resolve(); };
  const t = setTimeout(done, ms);
  for (const s of live) { if (s.aborted) { done(); return; } s.addEventListener("abort", done, { once: true }); }
});

export async function runWorker(o: WorkerOptions): Promise<WorkerStats> {
  const queue = new JobQueue(o.db, o.queue);
  const log = o.log ?? ((l: string) => console.log(l));
  const concurrency = Math.max(1, o.concurrency ?? DEFAULT_CONCURRENCY);
  const pollMs = o.pollMs ?? DEFAULT_POLL_MS;
  const sweepEveryMs = o.sweepEveryMs ?? DEFAULT_SWEEP_EVERY_MS;
  const deadlineMs = o.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const stats: WorkerStats = { done: 0, failed: 0, retried: 0, requeued: 0 };
  const inFlight = new Map<number, { abort: AbortController; done: Promise<void> }>();
  // Звільнений слот будить цикл одразу, а не через pollMs.
  let slotFreed = new AbortController();

  const start = (job: ClaimedJob): void => {
    const abort = new AbortController();
    const who = `job ${job.id} user ${idPrefix(job.userId)} ${job.reason}`;
    const t0 = performance.now();
    const ms = () => Math.round(performance.now() - t0);
    const done = (async () => {
      try {
        // П.14: людина чекає лише на 'connect' (перший бал після брифу); 'refresh' масовий, у фоні,
        // без нікого, хто чекає, тож не платить подвійним RPC за двопрохідний бал.
        const s = await scoreUser(job.userId, {
          registry: o.registry, db: o.db, env: o.env, signal: abort.signal, deadlineMs,
          fastFirstPass: job.reason === "connect",
        });
        const recorded = await queue.complete(job);
        stats.done++;
        log(`${who} done ${s.totalMs}ms gaps=${s.gaps.length}${s.gaps.length ? `(${s.gaps.join(",")})` : ""} ` +
          `scored=${s.scored} self-reported=${s.selfReported.join(",") || "none"}${recorded ? "" : " (job row already moved on)"}`);
      } catch (e) {
        if (abort.signal.aborted) {
          const back = await queue.requeue(job).catch(() => false);
          stats.requeued++;
          log(`${who} interrupted by shutdown ${ms()}ms, ${back ? "requeued" : "left for sweep"}`);
        } else {
          const status = await queue.fail(job, e).catch((err: unknown) => {
            log(`${who} could not record failure: ${shortError(err, 120)}`);
            return "left for sweep";
          });
          if (status === "queued") stats.retried++; else stats.failed++;
          log(`${who} failed attempt ${job.attempts}/${queue.maxAttempts} ${ms()}ms → ${status}: ${shortError(e, 120)}`);
        }
      } finally {
        inFlight.delete(job.id);
        slotFreed.abort();
      }
    })();
    inFlight.set(job.id, { abort, done });
  };

  let lastSweep = -Infinity;
  while (!o.stop.aborted) {
    try {
      if (performance.now() - lastSweep >= sweepEveryMs) {
        lastSweep = performance.now();
        const n = await queue.sweepStuck();
        if (n) log(`sweep: ${n} stuck job(s) returned to queue or failed`);
      }
      while (inFlight.size < concurrency && !o.stop.aborted) {
        const job = await queue.claimNext();
        if (!job) break;
        start(job);
      }
    } catch (e) {
      // D1 недоступна чи інша біда черги: не падаємо, пробуємо на наступному колі.
      log(`queue error: ${shortError(e, 160)}`);
    }
    if (slotFreed.signal.aborted) slotFreed = new AbortController();
    await delay(pollMs, o.stop, inFlight.size < concurrency ? undefined : slotFreed.signal);
  }

  if (inFlight.size) {
    const graceMs = o.graceMs ?? DEFAULT_GRACE_MS;
    log(`stopping: waiting up to ${graceMs} ms for ${inFlight.size} job(s)`);
    const all = Promise.all([...inFlight.values()].map((f) => f.done));
    const finished = await Promise.race([all.then(() => true), delay(graceMs, o.hardStop).then(() => false)]);
    if (!finished) {
      for (const f of inFlight.values()) f.abort.abort(new DOMException("worker shutdown", "AbortError"));
      await all;
    }
  }
  log(`stopped: done=${stats.done} retried=${stats.retried} failed=${stats.failed} requeued=${stats.requeued}`);
  return stats;
}

export function intEnv(env: EngineEnv, name: string, fallback: number, min = 1): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} має бути цілим ≥ ${min}, а не "${raw}"`);
  return n;
}

/** Процес worker: D1 і збирачі з оточення, SIGTERM/SIGINT для м'якої зупинки. */
export async function startWorker(env: EngineEnv = process.env, registry?: CollectorRegistry): Promise<WorkerStats> {
  const concurrency = intEnv(env, "ENGINE_CONCURRENCY", DEFAULT_CONCURRENCY);
  const deadlineMs = intEnv(env, "ENGINE_DEADLINE_MS", DEFAULT_DEADLINE_MS);
  const graceMs = intEnv(env, "ENGINE_SHUTDOWN_GRACE_MS", DEFAULT_GRACE_MS, 0);
  const db = dbFromEnv(env);
  const reg = registry ?? createRealRegistry();
  const stop = new AbortController();
  const hardStop = new AbortController();
  const onSignal = (sig: NodeJS.Signals) => {
    if (!stop.signal.aborted) { console.log(`${sig}: finishing in-flight jobs, send again to interrupt`); stop.abort(); }
    else hardStop.abort();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  console.log(`worker: concurrency ${concurrency}, deadline ${deadlineMs} ms`);
  try {
    return await runWorker({ db, registry: reg, env, stop: stop.signal, hardStop: hardStop.signal, concurrency, deadlineMs, graceMs });
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}

/** `node dist/main.js` запускає worker (те саме, що `node dist/cli.js worker`). */
function isEntry(): boolean {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isEntry()) {
  startWorker().then(() => process.exit(0), (e: unknown) => {
    console.error(`worker: ${shortError(e, 400)}`);
    process.exit(1);
  });
}
