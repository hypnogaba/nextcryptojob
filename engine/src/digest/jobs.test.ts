import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeJobsDb } from "../testing/jobs-fake.js";
import { D1Client } from "../d1.js";
import { __resetLimiters } from "../limits.js";
import { loadNextrolePool, parseDbTime } from "./jobs.js";
import { assertReadOnlySql, readOnlyJobsDb, ReadOnlySqlError } from "./jobs-db.js";

const NOW = new Date("2026-09-12T10:00:00Z");
let fake: FakeJobsDb;
beforeEach(() => { fake = new FakeJobsDb(NOW); });
afterEach(() => fake.close());

describe("база вакансій лише для читання", () => {
  it.each([
    "INSERT INTO jobs_cache (id) VALUES ('x')",
    "UPDATE jobs_cache SET title = 'x'",
    "DELETE FROM jobs_cache",
    "DROP TABLE jobs_cache",
    "PRAGMA table_info(jobs_cache)",
    "SELECT 1; DELETE FROM jobs_cache",
    "WITH x AS (SELECT 1) DELETE FROM jobs_cache",
    "REPLACE INTO jobs_cache (id) VALUES ('x')",
    "ATTACH DATABASE 'x' AS y",
    "",
  ])("відмовляє: %s", async (sql) => {
    const db = readOnlyJobsDb(fake);
    const before = fake.seen.length;
    await expect(db.select(sql)).rejects.toBeInstanceOf(ReadOnlySqlError);
    // Запит навіть не дійшов до бази.
    expect(fake.seen.length).toBe(before);
  });

  it("пропускає один SELECT, зокрема з ';' чи ключовим словом усередині рядка", async () => {
    fake.add({ id: "a", title: "Solidity Engineer" });
    const db = readOnlyJobsDb(fake);
    const r = await db.select<{ n: number }>("SELECT COUNT(*) AS n FROM jobs_cache WHERE title <> 'DELETE; DROP'");
    expect(r.rows[0]!.n).toBe(1);
    expect(() => assertReadOnlySql("WITH w AS (SELECT id FROM jobs_cache) SELECT * FROM w;")).not.toThrow();
  });

  it("назовні лише select: ні run, ні batch, ні execute", () => {
    const db = readOnlyJobsDb(fake) as unknown as Record<string, unknown>;
    expect(Object.keys(db)).toEqual(["select"]);
    expect(db.run).toBeUndefined();
    expect(db.batch).toBeUndefined();
    expect(Object.isFrozen(db)).toBe(true);
  });

  it("з D1Client бере meta: rows_read і тривалість", async () => {
    __resetLimiters();
    const fetchImpl = (async () => new Response(JSON.stringify({
      success: true, errors: [], result: [{ success: true, results: [{ id: "a" }], meta: { rows_read: 56955, rows_written: 0, duration: 84.2 } }],
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const db = readOnlyJobsDb(new D1Client({ accountId: "a", databaseId: "d", token: "t" }, { fetchImpl }));
    const r = await db.select("SELECT id FROM jobs_cache");
    expect(r.rows).toEqual([{ id: "a" }]);
    expect(r.meta).toEqual({ rowsRead: 56955, rowsWritten: 0, durationMs: 84.2 });
  });
});

describe("loadNextrolePool", () => {
  it("бере лише живі (бачені за 3 доби) з тегом web3 і опубліковані за 30 днів", async () => {
    const iso = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
    fake.add({ id: "live", title: "Solidity Engineer" });
    fake.add({ id: "gone", title: "Rust Engineer", fetchedAt: iso(4) });
    fake.add({ id: "nontag", title: "Backend Engineer", tags: ["engineering"] });
    fake.add({ id: "upper", title: "Backend Engineer", tags: ["WEB3"] });
    fake.add({ id: "old", title: "Go Engineer", postedAt: iso(40) });
    fake.add({ id: "undated", title: "Frontend Engineer", postedAt: null });
    const { jobs, stats } = await loadNextrolePool(readOnlyJobsDb(fake), NOW);
    expect(jobs.map((j) => j.id).sort()).toEqual(["live", "undated"]);
    expect(stats.dropped.tag).toBe(1); // LIKE без регістру пропустив "WEB3", точна перевірка ні
  });

  it("чистить не-крипто компанії й назви та назви без нашої ролі", async () => {
    fake.add({ id: "a", title: "Expert Audio Transcriber, Bulgarian", company: "Perle", companyKey: "perle" });
    fake.add({ id: "b", title: "Customer Success Manager", company: "Notion", companyKey: "notion" });
    fake.add({ id: "c", title: "Robata Chef", company: "Katana" });
    fake.add({ id: "d", title: "Associate", company: "Katana" });
    fake.add({ id: "e", title: "Senior Protocol Engineer", company: "Katana" });
    const { jobs, stats } = await loadNextrolePool(readOnlyJobsDb(fake), NOW);
    expect(jobs.map((j) => j.id)).toEqual(["e"]);
    expect(stats).toMatchObject({ fetched: 5, kept: 1, dropped: { tag: 0, company: 2, title: 2 } });
  });

  it("гібрид з прапорцем remote стає не віддаленим, дати з ISO розбираються", async () => {
    fake.add({ id: "h", title: "Solidity Engineer", location: "New York - Hybrid", remote: true });
    const { jobs } = await loadNextrolePool(readOnlyJobsDb(fake), NOW);
    expect(jobs[0]!.remote).toBe(false);
    expect(jobs[0]!.postedAt).toBe(NOW.getTime() - 2 * 86_400_000);
  });
});

describe("parseDbTime", () => {
  it("SQLite-формат (UTC за договором §9) і ISO дають ту саму мить", () => {
    expect(parseDbTime("2026-09-12 10:00:00")).toBe(Date.parse("2026-09-12T10:00:00Z"));
    expect(parseDbTime("2026-09-12T10:00:00.000Z")).toBe(Date.parse("2026-09-12T10:00:00Z"));
    expect(parseDbTime(null)).toBeNull();
    expect(parseDbTime("nope")).toBeNull();
  });
});
