import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { runWorker, type WorkerOptions } from "./main.js";
import { fakeRegistry, hangUntilAborted, sampleGithub } from "./pipeline/fake-registry.js";
import type { CollectorRegistry } from "./pipeline/registry.js";
import { SqliteD1 } from "./testing/sqlite-d1.js";

let db: SqliteD1;
type JobRow = { id: number; user_id: string; status: string; attempts: number; error: string | null };
const jobs = (): JobRow[] => db.all<JobRow>("SELECT id, user_id, status, attempts, error FROM score_jobs ORDER BY id");

async function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor: не дочекався");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Людина з одним GitHub (ідентичність з «секретним» логіном, щоб перевірити, що в журнал він не йде). */
const addPerson = (i: number): string => {
  const id = `user${i}-0000-aaaa-bbbb`;
  db.addUser(id);
  db.addIdentity(id, "github", `secret-login-${i}`);
  db.exec("INSERT INTO score_jobs (user_id, reason) VALUES (?, 'connect')", id);
  return id;
};

function start(registry: CollectorRegistry, extra: Partial<WorkerOptions> = {}) {
  const stop = new AbortController();
  const hardStop = new AbortController();
  const log: string[] = [];
  const done = runWorker({ db, registry, env: {}, stop: stop.signal, hardStop: hardStop.signal, pollMs: 5,
    queue: { retryAfterSeconds: 0 }, log: (l) => log.push(l), ...extra });
  return { stop, hardStop, log, done };
}

beforeEach(() => { db = new SqliteD1(); });
afterEach(() => db.close());

describe("worker", () => {
  it("обробляє чергу не більше ніж по concurrency людей; журнал без особистих даних", async () => {
    for (let i = 0; i < 5; i++) addPerson(i);
    let active = 0, peak = 0;
    const registry = fakeRegistry({
      collectGithub: async () => {
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return { ok: true, facts: sampleGithub() };
      },
    });
    const w = start(registry, { concurrency: 2 });
    await waitFor(() => jobs().every((j) => j.status === "done"));
    w.stop.abort();
    expect(await w.done).toMatchObject({ done: 5, failed: 0 });
    expect(peak).toBe(2);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM scores")!.n).toBe(5 * 15);

    const jobLines = w.log.filter((l) => l.startsWith("job "));
    expect(jobLines).toHaveLength(5);
    expect(jobLines[0]).toMatch(/^job \d+ user user\d-00 connect done \d+ms gaps=0 scored=\d+$/);
    expect(w.log.join("\n")).not.toMatch(/secret-login/);
  });

  it("збій запису: три спроби, потім failed, і worker живе далі", async () => {
    addPerson(1);
    db.beforeStatement = (sql) => { if (sql.startsWith("INSERT INTO source_facts")) throw new Error("D1 HTTP 500"); };
    const w = start(fakeRegistry());
    await waitFor(() => jobs()[0]!.status === "failed");
    w.stop.abort();
    expect(await w.done).toMatchObject({ done: 0, retried: 2, failed: 1 });
    expect(jobs()[0]).toMatchObject({ attempts: 3, error: "D1 HTTP 500" });
    expect(w.log.some((l) => /failed attempt 3\/3 \d+ms → failed/.test(l))).toBe(true);
  });

  it("зупинка: поточне завдання, що встигає в grace, закінчується", async () => {
    addPerson(1);
    const registry = fakeRegistry({
      collectGithub: async () => { await new Promise((r) => setTimeout(r, 60)); return { ok: true, facts: sampleGithub() }; },
    });
    const w = start(registry, { graceMs: 5_000 });
    await waitFor(() => jobs()[0]!.status === "running");
    w.stop.abort();
    expect(await w.done).toMatchObject({ done: 1, requeued: 0 });
    expect(jobs()[0]).toMatchObject({ status: "done", attempts: 1 });
  });

  it("зупинка: що не встигло за grace, повертається в чергу без втраченої спроби і без запису", async () => {
    addPerson(1);
    const w = start(fakeRegistry({ collectGithub: hangUntilAborted() }), { graceMs: 30, deadlineMs: 60_000 });
    await waitFor(() => jobs()[0]!.status === "running");
    w.stop.abort();
    expect(await w.done).toMatchObject({ done: 0, requeued: 1 });
    expect(jobs()[0]).toMatchObject({ status: "queued", attempts: 0 });
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM source_facts")!.n).toBe(0);
  });

  it("другий сигнал перериває, не чекаючи grace", async () => {
    addPerson(1);
    const w = start(fakeRegistry({ collectGithub: hangUntilAborted() }), { graceMs: 60_000, deadlineMs: 60_000 });
    await waitFor(() => jobs()[0]!.status === "running");
    w.stop.abort();
    setTimeout(() => w.hardStop.abort(), 20);
    const t0 = Date.now();
    expect(await w.done).toMatchObject({ requeued: 1 });
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("повертає завислі завдання під час роботи", async () => {
    const id = addPerson(1);
    db.exec("UPDATE score_jobs SET status = 'running', attempts = 1, started_at = datetime('now', '-11 minutes') WHERE user_id = ?", id);
    const w = start(fakeRegistry());
    await waitFor(() => jobs()[0]!.status === "done");
    w.stop.abort();
    await w.done;
    expect(jobs()[0]).toMatchObject({ attempts: 2 });
    expect(w.log.some((l) => l.startsWith("sweep: 1 stuck"))).toBe(true);
  });
});

describe("cli", () => {
  const cli = async (argv: string[]) => {
    const out: string[] = [];
    const code = await runCli(argv, { env: {}, db: () => db, registry: () => fakeRegistry(), out: (l) => out.push(l), err: (l) => out.push(l) });
    return { code, out: out.join("\n") };
  };

  it("score-user друкує підсумок і пише бал", async () => {
    const id = addPerson(1);
    const r = await cli(["score-user", id]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ userId: id, formula: "v5", gaps: [] });
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM scores WHERE user_id = ?", id)!.n).toBe(15);
  });

  it("enqueue-refresh ставить старих у межах годинного бюджету", async () => {
    for (let i = 0; i < 3; i++) {
      db.addUser(`old${i}`);
      db.exec("INSERT INTO source_facts (user_id, source, facts_json, fetched_at) VALUES (?, 'x', '{}', datetime('now', '-8 days'))", `old${i}`);
    }
    const r = await cli(["enqueue-refresh", "--per-hour", "2"]);
    expect(r).toEqual({ code: 0, out: "enqueue-refresh: 2 queued (hourly budget left 2)" });
    expect(jobs()).toHaveLength(2);
  });

  it("неправильний виклик: код 2 і підказка", async () => {
    expect((await cli(["nope"])).code).toBe(2);
    expect((await cli(["score-user"])).code).toBe(2);
    expect((await cli([])).out).toMatch(/usage/);
    expect((await cli(["enqueue-refresh", "--per-hour", "0"])).code).toBe(1);
  });

  it("без облікових даних D1 називає, яких змінних бракує", async () => {
    const out: string[] = [];
    const code = await runCli(["enqueue-refresh"], { env: {}, err: (l) => out.push(l) });
    expect(code).toBe(1);
    expect(out.join()).toMatch(/CF_ACCOUNT_ID, CF_D1_DATABASE_ID, CF_API_TOKEN/);
  });
});
