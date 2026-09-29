import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteD1 } from "../testing/sqlite-d1.js";
import { JobQueue, MAX_GAP_RETRIES } from "./queue.js";

type JobRow = { id: number; user_id: string; reason: string; status: string; attempts: number; error: string | null;
  started_at: string | null; finished_at: string | null };

let db: SqliteD1;
const SQL_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const enqueue = (userId: string, reason = "connect", queuedAt = "datetime('now')"): number => {
  db.exec(`INSERT INTO score_jobs (user_id, reason, queued_at) VALUES (?, ?, ${queuedAt})`, userId, reason);
  return db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
};
const job = (id: number): JobRow => db.get<JobRow>("SELECT * FROM score_jobs WHERE id = ?", id)!;
const users = (n: number, prefix = "u"): string[] => Array.from({ length: n }, (_, i) => {
  const id = `${prefix}${String(i).padStart(4, "0")}`;
  db.addUser(id);
  return id;
});

beforeEach(() => { db = new SqliteD1(); });
afterEach(() => db.close());

describe("claimNext", () => {
  it("одне завдання й вісім одночасних claimNext: бере рівно один", async () => {
    const [u] = users(1);
    const id = enqueue(u!);
    const got = await Promise.all(Array.from({ length: 8 }, () => new JobQueue(db).claimNext()));
    const won = got.filter((g) => g !== null);
    expect(won).toHaveLength(1);
    expect(won[0]).toMatchObject({ id, userId: u, reason: "connect", attempts: 1 });
    expect(job(id)).toMatchObject({ status: "running", attempts: 1 });
    expect(job(id).started_at).toMatch(SQL_TIME);
  });

  it("п'ять завдань і дванадцять одночасних claimNext: кожне взяте рівно раз", async () => {
    const ids = users(5).map((u) => enqueue(u));
    const got = await Promise.all(Array.from({ length: 12 }, () => new JobQueue(db).claimNext()));
    const won = got.filter((g) => g !== null).map((g) => g!.id).sort((a, b) => a - b);
    expect(won).toEqual(ids);
    for (const id of ids) expect(job(id)).toMatchObject({ status: "running", attempts: 1 });
  });

  it("бере найстаріше", async () => {
    const [a, b] = users(2);
    const newer = enqueue(a!, "connect", "datetime('now', '-1 minutes')");
    const older = enqueue(b!, "refresh", "datetime('now', '-5 minutes')");
    expect((await new JobQueue(db).claimNext())?.id).toBe(older);
    expect((await new JobQueue(db).claimNext())?.id).toBe(newer);
    expect(await new JobQueue(db).claimNext()).toBeNull();
  });

  it("не бере друге завдання людини, поки перше running", async () => {
    const [u] = users(1);
    enqueue(u!, "connect", "datetime('now', '-2 minutes')");
    enqueue(u!, "manual");
    const q = new JobQueue(db);
    expect(await q.claimNext()).not.toBeNull();
    expect(await q.claimNext()).toBeNull();
  });
});

describe("fail і повтори", () => {
  it("до трьох спроб, потім failed; помилка коротка й без ключів", async () => {
    const [u] = users(1);
    const id = enqueue(u!);
    const q = new JobQueue(db, { retryAfterSeconds: 0 });
    const secret = new Error(`upstream said no at https://api.etherscan.io/v2/api?module=account&apikey=SECRET123 ${"x".repeat(500)}`);

    for (const attempt of [1, 2]) {
      const j = await q.claimNext();
      expect(j).toMatchObject({ id, attempts: attempt });
      expect(await q.fail(j!, secret)).toBe("queued");
      expect(job(id)).toMatchObject({ status: "queued", attempts: attempt, finished_at: null });
    }
    const last = await q.claimNext();
    expect(last).toMatchObject({ id, attempts: 3 });
    expect(await q.fail(last!, secret)).toBe("failed");

    const row = job(id);
    expect(row).toMatchObject({ status: "failed", attempts: 3 });
    expect(row.finished_at).toMatch(SQL_TIME);
    expect(row.error).not.toContain("SECRET123");
    expect(row.error).toContain("apikey=***");
    expect(row.error!.length).toBeLessThanOrEqual(200);
    expect(await q.claimNext()).toBeNull();
  });

  it("невдале завдання чекає retryAfterSeconds від початку спроби", async () => {
    const [u] = users(1);
    const id = enqueue(u!);
    const q = new JobQueue(db, { retryAfterSeconds: 60 });
    await q.fail((await q.claimNext())!, new Error("boom"));
    expect(await q.claimNext()).toBeNull();
    db.exec("UPDATE score_jobs SET started_at = datetime('now', '-61 seconds') WHERE id = ?", id);
    expect(await q.claimNext()).toMatchObject({ id, attempts: 2 });
  });

  it("requeue після зупинки не рахує спробу", async () => {
    const [u] = users(1);
    const id = enqueue(u!);
    const q = new JobQueue(db);
    expect(await q.requeue((await q.claimNext())!)).toBe(true);
    expect(job(id)).toMatchObject({ status: "queued", attempts: 0, started_at: null });
    expect(await q.claimNext()).toMatchObject({ id, attempts: 1 });
  });
});

describe("sweepStuck", () => {
  it("running довше 10 хв: знову queued, або failed після третьої спроби; свіжі не чіпає", async () => {
    const [a, b, c] = users(3);
    const stuck = enqueue(a!), exhausted = enqueue(b!), fresh = enqueue(c!);
    db.exec("UPDATE score_jobs SET status = 'running', attempts = 1, started_at = datetime('now', '-11 minutes') WHERE id = ?", stuck);
    db.exec("UPDATE score_jobs SET status = 'running', attempts = 3, started_at = datetime('now', '-11 minutes') WHERE id = ?", exhausted);
    db.exec("UPDATE score_jobs SET status = 'running', attempts = 1, started_at = datetime('now', '-5 minutes') WHERE id = ?", fresh);

    expect(await new JobQueue(db).sweepStuck()).toBe(2);
    expect(job(stuck)).toMatchObject({ status: "queued", attempts: 1 });
    expect(job(stuck).error).toMatch(/stuck/);
    expect(job(exhausted)).toMatchObject({ status: "failed", attempts: 3 });
    expect(job(exhausted).finished_at).toMatch(SQL_TIME);
    expect(job(fresh)).toMatchObject({ status: "running" });
  });

  it("запізніле complete від спроби, яку вже підібрав sweep, нічого не змінює", async () => {
    const [u] = users(1);
    const id = enqueue(u!);
    const q = new JobQueue(db, { retryAfterSeconds: 0 });
    const first = (await q.claimNext())!;
    db.exec("UPDATE score_jobs SET started_at = datetime('now', '-11 minutes') WHERE id = ?", id);
    await q.sweepStuck();
    const second = (await q.claimNext())!;
    expect(second.attempts).toBe(2);

    expect(await q.complete(first)).toBe(false);
    expect(await q.fail(first, new Error("late"))).toBe("stale");
    expect(job(id)).toMatchObject({ status: "running", attempts: 2 });
    expect(await q.complete(second)).toBe(true);
    expect(job(id)).toMatchObject({ status: "done", error: null });
  });
});

describe("complete", () => {
  it("закриває старіші queued тієї самої людини, але не ті, що прийшли після початку", async () => {
    const [u, other] = users(2);
    const first = enqueue(u!, "connect", "datetime('now', '-5 minutes')");
    const before = enqueue(u!, "manual", "datetime('now', '-2 minutes')");
    const otherJob = enqueue(other!, "connect", "datetime('now', '-3 minutes')");
    const q = new JobQueue(db);
    const j = (await q.claimNext())!;
    expect(j.id).toBe(first);
    const after = enqueue(u!, "connect", "datetime('now', '+1 minutes')");

    expect(await q.complete(j)).toBe(true);
    expect(job(first).status).toBe("done");
    expect(job(before).status).toBe("done");
    expect(job(after).status).toBe("queued");
    expect(job(otherJob).status).toBe("queued");
  });
});

describe("enqueueRefresh", () => {
  const addFacts = (userId: string, source: string, ageSql: string): void =>
    db.exec(`INSERT INTO source_facts (user_id, source, facts_json, fetched_at) VALUES (?, ?, '{}', datetime('now', '${ageSql}'))`,
      userId, source);

  it("1000 людей зі старими фактами розходяться по тижню: ≤ 6 за годину, кожен рівно раз", async () => {
    for (const u of users(1000)) addFacts(u, "x", "-8 days");
    const q = new JobQueue(db);

    expect(await q.enqueueRefresh()).toEqual({ enqueued: 6, budget: 6 });
    // Той самий час: годинна межа вже вибрана, подвійний таймер нічого не додає.
    expect(await q.enqueueRefresh()).toEqual({ enqueued: 0, budget: 0 });

    let hours = 1;
    const perHour: number[] = [6];
    for (; hours < 400; hours++) {
      // Година минула: поставлені відпрацювали, їхні факти свіжі.
      db.exec("UPDATE source_facts SET fetched_at = datetime('now') WHERE user_id IN " +
        "(SELECT user_id FROM score_jobs WHERE status = 'queued' AND reason = 'refresh')");
      db.exec("UPDATE score_jobs SET status = 'done', queued_at = datetime(queued_at, '-1 hour')");
      const stale = db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM (SELECT user_id FROM source_facts GROUP BY user_id HAVING MIN(fetched_at) < datetime('now', '-7 days'))")!.n;
      if (stale === 0) break;
      const { enqueued } = await q.enqueueRefresh();
      perHour.push(enqueued);
    }
    expect(hours).toBeLessThanOrEqual(7 * 24);
    expect(Math.max(...perHour)).toBeLessThanOrEqual(6);
    const counts = db.all<{ n: number }>("SELECT COUNT(*) AS n FROM score_jobs GROUP BY user_id");
    expect(counts).toHaveLength(1000);
    expect(counts.every((c) => c.n === 1)).toBe(true);
  });

  it("не ставить тих, хто вже в черзі чи в роботі, і тих, у кого факти свіжі; найстаріші першими", async () => {
    const [queued, running, fresh, mixed, oldest] = users(5);
    addFacts(queued!, "x", "-9 days"); enqueue(queued!, "connect");
    addFacts(running!, "x", "-9 days");
    db.exec("INSERT INTO score_jobs (user_id, reason, status, attempts, started_at) VALUES (?, 'manual', 'running', 1, datetime('now'))", running);
    addFacts(fresh!, "x", "-1 days");
    addFacts(mixed!, "x", "-1 days"); addFacts(mixed!, "github", "-8 days");
    addFacts(oldest!, "github", "-30 days");

    const q = new JobQueue(db);
    expect(await q.enqueueRefresh({ perHour: 1 })).toEqual({ enqueued: 1, budget: 1 });
    expect(db.all<{ user_id: string }>("SELECT user_id FROM score_jobs WHERE reason = 'refresh'")).toEqual([{ user_id: oldest }]);

    db.exec("UPDATE score_jobs SET queued_at = datetime('now', '-2 hours') WHERE reason = 'refresh'");
    expect(await q.enqueueRefresh({ perHour: 10 })).toEqual({ enqueued: 1, budget: 10 });
    const refreshed = db.all<{ user_id: string }>("SELECT user_id FROM score_jobs WHERE reason = 'refresh' ORDER BY id").map((r) => r.user_id);
    expect(refreshed).toEqual([oldest, mixed]);
  });
});

describe("повтор після тимчасової прогалини (C2)", () => {
  const addFacts = (userId: string, source: string, ageSql: string): void =>
    db.exec(`INSERT INTO source_facts (user_id, source, facts_json, fetched_at) VALUES (?, ?, '{}', datetime('now', '${ageSql}'))`,
      userId, source);

  it("ставиться з затримкою: одразу не береться, а коли час настав, береться з номером повтору", async () => {
    const [u] = users(1);
    const q = new JobQueue(db);
    expect(await q.enqueueGapRetry(u!, 1)).toBe(true);
    expect(await q.claimNext()).toBeNull();              // ще за ~годину
    db.exec("UPDATE score_jobs SET started_at = datetime('now', '-2 minutes')");
    expect(await q.claimNext()).toMatchObject({ userId: u, reason: "refresh", gapRetry: 1 });
  });

  it("не більше MAX_GAP_RETRIES повторів у ланцюжку", async () => {
    const [u] = users(1);
    const q = new JobQueue(db);
    expect(await q.enqueueGapRetry(u!, MAX_GAP_RETRIES)).toBe(true);
    db.exec("UPDATE score_jobs SET status = 'done'");
    expect(await q.enqueueGapRetry(u!, MAX_GAP_RETRIES + 1)).toBe(false);
    expect(await q.enqueueGapRetry(u!, 0)).toBe(false);
  });

  it("не дублює, якщо людина вже в черзі чи в роботі (той збір і так свіжий)", async () => {
    const [queued, running] = users(2);
    enqueue(queued!);
    db.exec("INSERT INTO score_jobs (user_id, reason, status, attempts, started_at) VALUES (?, 'manual', 'running', 1, datetime('now'))", running);
    const q = new JobQueue(db);
    expect(await q.enqueueGapRetry(queued!, 1)).toBe(false);
    expect(await q.enqueueGapRetry(running!, 1)).toBe(false);
  });

  it("завершене завдання-повтор скидає позначку, тож ланцюжок рахує лише свої повтори", async () => {
    const [u] = users(1);
    const q = new JobQueue(db, { retryAfterSeconds: 0 });
    await q.enqueueGapRetry(u!, 2, 0);
    const claimed = (await q.claimNext())!;
    expect(claimed.gapRetry).toBe(2);
    await q.complete(claimed);
    expect(db.get<{ error: string | null }>("SELECT error FROM score_jobs WHERE id = ?", claimed.id)!.error).toBeNull();
  });

  it("тижневе оновлення не бере людину, яку щойно оновлено (тимчасова прогалина не тримає факти свіжими)", async () => {
    const [stuck, other] = users(2);
    addFacts(stuck!, "x", "-30 days");   // найстарший: без винятку тягнувся б першим щогодини
    addFacts(other!, "x", "-9 days");
    db.exec("INSERT INTO score_jobs (user_id, reason, status, attempts, queued_at, finished_at) VALUES (?, 'refresh', 'done', 1, datetime('now', '-3 hours'), datetime('now', '-2 hours'))", stuck);
    const q = new JobQueue(db);
    expect(await q.enqueueRefresh({ perHour: 1 })).toEqual({ enqueued: 1, budget: 1 });
    expect(db.all<{ user_id: string }>("SELECT user_id FROM score_jobs WHERE status = 'queued'")).toEqual([{ user_id: other }]);
    // Доба минула: знову його черга.
    db.exec("UPDATE score_jobs SET status = 'done', queued_at = datetime('now', '-3 hours') WHERE status = 'queued'");
    db.exec("UPDATE score_jobs SET finished_at = datetime('now', '-30 hours') WHERE user_id = ?", stuck);
    db.exec("UPDATE score_jobs SET finished_at = datetime('now', '-30 hours') WHERE user_id = ?", other);
    expect((await q.enqueueRefresh({ perHour: 1 })).enqueued).toBe(1);
    expect(db.all<{ user_id: string }>("SELECT user_id FROM score_jobs WHERE status = 'queued'")).toEqual([{ user_id: stuck }]);
  });
});

describe("enqueueFormulaRefresh auto (C6)", () => {
  const addScore = (id: string, version: string) =>
    db.exec("INSERT INTO scores (user_id, role, score, core, cover, breakdown_json, formula_version) VALUES (?, 'bd', 50, 50, 100, '{}', ?)", id, version);

  it("auto пропускає тих, кого перераховано за 6 годин, і тих, чий збір упав за добу; ручний режим бере всіх", async () => {
    const [fresh, failed, plain] = users(3);
    for (const u of [fresh!, failed!, plain!]) addScore(u, "v5");
    db.exec("INSERT INTO score_jobs (user_id, reason, status, attempts, finished_at) VALUES (?, 'refresh', 'done', 1, datetime('now', '-1 hours'))", fresh);
    db.exec("INSERT INTO score_jobs (user_id, reason, status, attempts, finished_at) VALUES (?, 'refresh', 'failed', 3, datetime('now', '-3 hours'))", failed);
    const q = new JobQueue(db);
    expect((await q.enqueueFormulaRefresh("v9", { auto: true })).enqueued).toBe(1);
    expect(db.all<{ user_id: string }>("SELECT user_id FROM score_jobs WHERE status = 'queued'")).toEqual([{ user_id: plain }]);
    db.exec("UPDATE score_jobs SET status = 'done' WHERE status = 'queued'");
    expect((await q.enqueueFormulaRefresh("v9")).enqueued).toBe(3);
  });
});
