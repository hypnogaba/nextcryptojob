import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, STALE_FORMULA_PER_RUN } from "./cli.js";
import { FORMULA_VERSION } from "./formula/score.js";
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
    expect(jobLines[0]).toMatch(/^job \d+ user user\d-00 connect done \d+ms gaps=0 scored=\d+ self-reported=github$/);
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

  it("п.14: reason 'connect' рахує бал двопрохідно (людина чекає), 'refresh' звичайно, одним проходом", async () => {
    const solanaCallsFor: Record<string, number> = {};
    const registry = fakeRegistry({
      collectSolana: async (addresses: readonly string[]) => {
        const id = addresses[0]!;
        solanaCallsFor[id] = (solanaCallsFor[id] ?? 0) + 1;
        return { ok: true, facts: {} };
      },
    });
    const connectId = "connect-user-0000";
    const refreshId = "refresh-user-0000";
    db.addUser(connectId);
    db.addIdentity(connectId, "solana", connectId);
    db.exec("INSERT INTO score_jobs (user_id, reason) VALUES (?, 'connect')", connectId);
    db.addUser(refreshId);
    db.addIdentity(refreshId, "solana", refreshId);
    db.exec("INSERT INTO score_jobs (user_id, reason) VALUES (?, 'refresh')", refreshId);

    const w = start(registry, { concurrency: 1 });
    await waitFor(() => jobs().every((j) => j.status === "done"));
    w.stop.abort();
    await w.done;
    expect(solanaCallsFor[connectId]).toBe(2);
    expect(solanaCallsFor[refreshId]).toBe(1);
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
    expect(JSON.parse(r.out)).toMatchObject({ userId: id, formula: FORMULA_VERSION, gaps: [] });
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

  it("enqueue-refresh --stale-formula ставить усіх з балом іншої версії формули, навіть зі свіжими фактами", async () => {
    const add = (id: string, version: string) => {
      db.addUser(id);
      db.exec("INSERT INTO source_facts (user_id, source, facts_json) VALUES (?, 'x', '{}')", id);
      db.exec("INSERT INTO scores (user_id, role, score, core, cover, breakdown_json, formula_version) VALUES (?, 'bd', 50, 50, 100, '{}', ?)",
        id, version);
    };
    add("old1", "v5"); add("old2", "v5"); add("cur", FORMULA_VERSION);
    const r = await cli(["enqueue-refresh", "--stale-formula"]);
    expect(r).toEqual({ code: 0, out: `enqueue-refresh: 2 queued with scores from a formula other than ${FORMULA_VERSION}` });
    expect(jobs().map((j) => j.user_id).sort()).toEqual(["old1", "old2"]);
    // Повтор нікого не дублює: обидва вже в черзі.
    expect((await cli(["enqueue-refresh", "--stale-formula"])).out).toMatch(/^enqueue-refresh: 0 queued/);
  });

  it("enqueue-refresh --stale-formula не чіпає демо-кандидатів (без джерел їхній бал став би порожнім)", async () => {
    db.exec("ALTER TABLE users ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0");
    for (const [id, demo] of [["real", 0], ["demo", 1]] as const) {
      db.addUser(id);
      db.exec("UPDATE users SET is_demo = ? WHERE id = ?", demo, id);
      db.exec("INSERT INTO scores (user_id, role, score, core, cover, breakdown_json, formula_version) VALUES (?, 'bd', 50, 50, 100, '{}', 'v6')", id);
    }
    expect((await cli(["enqueue-refresh", "--stale-formula"])).out).toMatch(/^enqueue-refresh: 1 queued/);
    expect(jobs().map((j) => j.user_id)).toEqual(["real"]);
  });

  it("enqueue-refresh --stale-formula --per-hour N ставить не більше N", async () => {
    for (const id of ["a1", "a2", "a3"]) {
      db.addUser(id);
      db.exec("INSERT INTO scores (user_id, role, score, core, cover, breakdown_json, formula_version) VALUES (?, 'bd', 50, 50, 100, '{}', 'v5')", id);
    }
    expect((await cli(["enqueue-refresh", "--stale-formula", "--per-hour", "2"])).out).toMatch(/^enqueue-refresh: 2 queued/);
    expect(jobs()).toHaveLength(2);
  });

  it("score-facts: збирачі й формула без D1, друк часу, прогалин і балів; ключі лише «set/missing»", async () => {
    const out: string[] = [];
    const registry = fakeRegistry({ collectSolana: async () => ({ ok: true, facts: { S: { sigs: 3, sigsOk: 3, sigsCapped: false,
      firstTs: null, sampleSeen: 3, sampleSwaps: 1, swaps: 1 } }, partial: { S1234567890: "swaps: stopped early: deadline" } }) });
    const code = await runCli(["score-facts", "--x", "@Alice", "--github", "Alice-GH", "--site", "alice.dev", "--evm",
      `${"0x" + "A".repeat(40)},${"0x" + "b".repeat(40)}`, "--solana", "S1234567890", "--sherlock", "alice"],
    { env: { TWITTER_TOKEN: "secret-token-value" }, db: () => { throw new Error("D1 must not be touched"); }, registry: () => registry,
      out: (l) => out.push(l), err: (l) => out.push(l) });
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).not.toContain("secret-token-value");
    expect(text).toMatch(/TWITTER_TOKEN set, GITHUB_TOKEN missing/);
    expect(text).toMatch(/^x +\d+ +ok$/m);
    expect(text).toMatch(/solana\.S1234567: swaps: stopped early: deadline/);
    expect(text).toMatch(/^trader +\d+\.\d/m);
    const inputs = Object.fromEntries(registry.calls.map((c) => [c.collector, c.input]));
    expect(inputs).toMatchObject({ collectX: "alice", collectGithub: "alice-gh", collectSite: "https://alice.dev",
      collectEvm: ["0x" + "a".repeat(40), "0x" + "b".repeat(40)], collectAudits: { sherlock: "alice", github: "alice-gh", x: "alice" } });
  });

  it("score-facts без жодної ідентичності: код 2", async () => {
    expect((await cli(["score-facts"])).code).toBe(2);
    expect((await cli(["score-facts", "--json"])).code).toBe(2);
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

describe("worker: повтор після тимчасової прогалини (C2)", () => {
  it("таймаут джерела: завдання done, факти збережені, повтор стоїть у черзі з затримкою й номером; журнал каже про це", async () => {
    const id = addPerson(1);
    // Перший збір добрий, другий (тижневе оновлення) зі збоєм джерела.
    await runCliScore(id);
    db.exec("UPDATE source_facts SET fetched_at = '2026-09-01 10:00:00' WHERE user_id = ?", id);
    db.exec("DELETE FROM score_jobs");
    db.exec("INSERT INTO score_jobs (user_id, reason) VALUES (?, 'refresh')", id);
    const w = start(fakeRegistry({ collectGithub: async () => ({ ok: false, gap: "timeout" }) }));
    await waitFor(() => jobs().some((j) => j.status === "done"));
    w.stop.abort();
    await w.done;

    expect(db.get<{ fetched_at: string; facts_json: string | null }>("SELECT fetched_at, facts_json FROM source_facts WHERE user_id = ? AND source = 'github'", id))
      .toMatchObject({ fetched_at: "2026-09-01 10:00:00", facts_json: JSON.stringify(sampleGithub()) });
    const retry = jobs().find((j) => j.status === "queued");
    expect(retry).toMatchObject({ user_id: id, error: "gap-retry:1", attempts: 0 });
    expect(w.log.some((l) => /transient=github kept=github gap-retry queued \(1\/3\)/.test(l))).toBe(true);
    // Через годину повтор береться; знову збій: далі ланцюжок росте, поки не вичерпається.
    db.exec("UPDATE score_jobs SET started_at = datetime('now', '-2 minutes') WHERE status = 'queued'");
    const w2 = start(fakeRegistry({ collectGithub: async () => ({ ok: false, gap: "timeout" }) }));
    await waitFor(() => jobs().some((j) => j.error === "gap-retry:2"));
    w2.stop.abort();
    await w2.done;
    expect(jobs().filter((j) => j.status === "queued").map((j) => j.error)).toEqual(["gap-retry:2"]);
  });

  it("справжня прогалина повтор не ставить", async () => {
    addPerson(1);
    const w = start(fakeRegistry({ collectGithub: async () => ({ ok: false, gap: "GitHub: user not found" }) }));
    await waitFor(() => jobs().every((j) => j.status === "done"));
    w.stop.abort();
    await w.done;
    expect(jobs()).toHaveLength(1);
  });

  async function runCliScore(id: string): Promise<void> {
    const code = await runCli(["score-user", id], { env: {}, db: () => db, registry: () => fakeRegistry(), out: () => undefined, err: () => undefined });
    expect(code).toBe(0);
  }
});

describe("cli: enqueue-refresh сам перераховує старі формули (C6)", () => {
  const cli = async (argv: string[]) => {
    const out: string[] = [];
    const code = await runCli(argv, { env: {}, db: () => db, registry: () => fakeRegistry(), out: (l) => out.push(l), err: (l) => out.push(l) });
    return { code, out: out.join("\n") };
  };
  const addScored = (id: string, version: string) => {
    db.addUser(id);
    db.exec("INSERT INTO source_facts (user_id, source, facts_json) VALUES (?, 'x', '{}')", id);
    db.exec("INSERT INTO scores (user_id, role, score, core, cover, breakdown_json, formula_version) VALUES (?, 'bd', 50, 50, 100, '{}', ?)", id, version);
  };

  it("звичайний прогін таймера без прапорців ставить людей зі старою версією, і повтор нікого не дублює", async () => {
    addScored("old1", "v8"); addScored("old2", "v8"); addScored("cur", FORMULA_VERSION);
    const first = await cli(["enqueue-refresh"]);
    expect(first.out).toMatch(new RegExp(`, 2 more with scores from a formula other than ${FORMULA_VERSION}$`));
    expect(jobs().map((j) => j.user_id).sort()).toEqual(["old1", "old2"]);
    expect((await cli(["enqueue-refresh"])).out).not.toMatch(/more with scores/);
    expect(jobs()).toHaveLength(2);
  });

  it("темп черги: не більше STALE_FORMULA_PER_RUN за прогін, решта наступного разу", async () => {
    for (let i = 0; i < STALE_FORMULA_PER_RUN + 5; i++) addScored(`p${String(i).padStart(3, "0")}`, "v8");
    await cli(["enqueue-refresh"]);
    expect(jobs()).toHaveLength(STALE_FORMULA_PER_RUN);
    // Worker перерахував тих двадцятьох: бал уже нової версії, завдання done.
    db.exec(`UPDATE scores SET formula_version = '${FORMULA_VERSION}' WHERE user_id IN (SELECT user_id FROM score_jobs)`);
    db.exec("UPDATE score_jobs SET status = 'done', finished_at = datetime('now')");
    await cli(["enqueue-refresh"]);
    expect(jobs().filter((j) => j.status === "queued")).toHaveLength(5);
  });

  it("людина, чий бал вже нової версії, не ставиться; кому оновлення щойно вдалось, теж", async () => {
    addScored("cur", FORMULA_VERSION);
    expect((await cli(["enqueue-refresh"])).out).not.toMatch(/more with scores/);
    expect(jobs()).toHaveLength(0);
  });
});
