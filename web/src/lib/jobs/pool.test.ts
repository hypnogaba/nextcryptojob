import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobsDb } from "@/lib/jobs-db";
import { FAILURE_BACKOFF_MS, crawlPool, POOL_ROW_CAP, POOL_TTL_MS, poolStats, resetCrawlPool } from "./pool";

/**
 * Пул вакансій для search_jobs: читання не частіше за раз на POOL_TTL_MS, без спільного
 * незавершеного запиту між запитами, пауза після невдачі з попереднім пулом, найсвіжіші
 * рядки першими й попередження, коли спрацювала межа рядків.
 */

const NOW = new Date("2026-09-13T12:00:00Z");

function row(id: string, title = "Solidity Engineer") {
  return {
    id, url: `https://boards.example.com/${id}`, company: "Chain Labs", company_key: "chain labs", title, location: "Remote",
    remote: 1, salary_min: null, salary_max: null, salary_currency: null, tags: '["web3"]', posted_at: "2026-09-12T00:00:00Z",
    fetched_at: "2026-09-13T06:00:00Z", country: null, dedupe_key: `${id}-d`,
  };
}

/** Замінник бази вакансій: пише кожен запит і відповідає рядками або помилкою. */
function fakeDb(answer: () => Promise<unknown[]>) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db: JobsDb = {
    all: async <T,>(sql: string, ...params: unknown[]) => {
      calls.push({ sql, params });
      return (await answer()) as T[];
    },
    first: async () => null,
  };
  return { db, calls };
}

let clock = 0;
beforeEach(() => {
  resetCrawlPool();
  clock = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("Job pool", () => {
  it("reads the freshest rows first, at most the cap, and says so when the cap is hit", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { db, calls } = fakeDb(async () => [row("a"), row("b")]);
    const jobs = await crawlPool(() => db, NOW, 2);
    expect(jobs?.map((j) => j.jobId)).toEqual(["nr_a", "nr_b"]);
    expect(calls[0].sql).toMatch(/ORDER BY fetched_at DESC\s+LIMIT \?$/);
    expect(calls[0].params.at(-1)).toBe(2);
    expect(warn).toHaveBeenCalledWith("search_jobs: job pool hit the 2-row cap; older jobs are left out");
    expect(POOL_ROW_CAP).toBe(10_000);
  });

  it("keeps a finished pool for 10 minutes, then reads again", async () => {
    const { db, calls } = fakeDb(async () => [row("a")]);
    await crawlPool(() => db, NOW);
    clock += POOL_TTL_MS - 1;
    await crawlPool(() => db, NOW);
    expect(calls).toHaveLength(1);
    clock += 2;
    await crawlPool(() => db, NOW);
    expect(calls).toHaveLength(2);
  });

  it("does not share a read that is still running: two requests on a miss read for themselves", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { db, calls } = fakeDb(async () => {
      await gate;
      return [row("a")];
    });
    const first = crawlPool(() => db, NOW);
    const second = crawlPool(() => db, NOW);
    await Promise.resolve();
    expect(calls).toHaveLength(2);
    release();
    expect((await first)?.length).toBe(1);
    expect((await second)?.length).toBe(1);
    // Готовий результат уже спільний.
    await crawlPool(() => db, NOW);
    expect(calls).toHaveLength(2);
  });

  it("after a failed read waits 60 seconds and serves the previous pool, even a stale one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let fail = false;
    const { db, calls } = fakeDb(async () => {
      if (fail) throw new Error("D1_ERROR: overloaded");
      return [row("a")];
    });
    expect((await crawlPool(() => db, NOW))?.map((j) => j.jobId)).toEqual(["nr_a"]);

    fail = true;
    clock += POOL_TTL_MS + 1; // пул застарів
    expect((await crawlPool(() => db, NOW))?.map((j) => j.jobId)).toEqual(["nr_a"]);
    expect(calls).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith("search_jobs: serving the previous job pool while the jobs database does not answer");

    clock += FAILURE_BACKOFF_MS - 1; // пауза: базу не питаємо
    expect((await crawlPool(() => db, NOW))?.map((j) => j.jobId)).toEqual(["nr_a"]);
    expect(calls).toHaveLength(2);

    fail = false;
    clock += 2; // пауза минула: читаємо знову
    await crawlPool(() => db, NOW);
    expect(calls).toHaveLength(3);
  });

  it("with no previous pool a failure gives nothing (company jobs only), and the pause still holds", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { db, calls } = fakeDb(async () => {
      throw new Error("D1_ERROR: 429");
    });
    expect(await crawlPool(() => db, NOW)).toBeNull();
    expect(await crawlPool(() => db, NOW)).toBeNull();
    expect(calls).toHaveLength(1);
    const unbound = await (async () => {
      resetCrawlPool();
      return crawlPool(() => {
        throw new TypeError("Cannot read properties of undefined (reading 'prepare')");
      }, NOW);
    })();
    expect(unbound).toBeNull();
  });
});

describe("pool sieve counters", () => {
  it("keeps a crypto job with no role of ours, counts it, and names the most common such titles", async () => {
    const { db } = fakeDb(async () => [
      row("a", "Senior Solidity Engineer"),
      row("b", "Security Auditor"),
      row("c", "Tokenomics Wizard"),
      row("d", "Tokenomics Wizard"),
      { ...row("e", "Solidity Engineer"), tags: '["jobs"]' },
    ]);
    const pool = await crawlPool(() => db, NOW);
    const s = poolStats();
    expect(s).not.toBeNull();
    expect(s!.read).toBe(5);
    expect(s!.kept).toBe(pool!.length);
    expect(s!.kept + s!.dropped.title + s!.dropped.tag + s!.dropped.company + s!.dropped.url).toBe(5);
    // Не web3 падає за тегом; «Tokenomics Wizard» лишається, але без ролі.
    expect(s!.dropped.tag).toBe(1);
    expect(s!.dropped.title).toBe(0);
    expect(s!.roleless).toBe(2);
    expect(pool!.filter((j) => j.roles.length === 0)).toHaveLength(2);
    // Найчастіша безрольна назва перша, рівно як у базі.
    expect(s!.rolelessTitles[0]).toMatchObject({ title: "Tokenomics Wizard", company: "Chain Labs", n: 2 });
  });
});
