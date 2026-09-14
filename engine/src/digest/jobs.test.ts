import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeJobsDb } from "../testing/jobs-fake.js";
import { D1Client } from "../d1.js";
import { __resetLimiters } from "../limits.js";
import { companyJob, estimateText, loadCrawlPool, parseDbTime } from "./jobs.js";
import { selectJobs } from "./match.js";
import { deliveryJobs } from "./schedule.js";
import { emailPayload, telegramText } from "./deliver.js";
import { assertReadOnlySql, readOnlyJobsDb, ReadOnlySqlError } from "./jobs-db.js";

const NOW = new Date("2026-09-12T10:00:00Z");
let fake: FakeJobsDb;
beforeEach(() => { fake = new FakeJobsDb(NOW); });
afterEach(() => fake.close());

describe("оцінка зарплати від дошки (web3.career): лише підпис, ніколи не зарплата", () => {
  const add = () => {
    fake.add({ id: "est", title: "Community Manager", company: "Koinly", source: "board:web3career", estimate: [180_000, 225_000, "USD"] });
    fake.add({ id: "paid", title: "Community Lead", company: "Paid Co", salaryMin: 90_000, salaryMax: 100_000, salaryCurrency: "USD",
      estimate: [300_000, 400_000, "USD"] });
  };

  it("пул: у DigestJob вилки немає, оцінка окремо й лише там, де роботодавець вилки не дав", async () => {
    add();
    const pool = await loadCrawlPool(readOnlyJobsDb(fake), NOW);
    const est = pool.jobs.find((j) => j.id === "est")!;
    expect(est.salary).toBeNull();
    expect(JSON.stringify(est)).not.toMatch(/180000|estimate/);
    expect([...pool.estimates.keys()]).toEqual(["nr:est"]);
    expect(estimateText(pool.estimates.get("nr:est"))).toBe("est. $180k to $225k (web3.career estimate)");
  });

  it("підбір за зарплатою її не бачить: людина з мінімумом 150k не отримує «Salary listed» і не відсіює за нею", async () => {
    add();
    const pool = await loadCrawlPool(readOnlyJobsDb(fake), NOW);
    const picks = selectJobs({ crawl: pool.jobs, company: [] },
      { roles: ["community"], remoteMode: "remote", city: null, salaryMin: 150_000, salaryCurrency: "USD" }, { now: NOW, exclude: new Set() });
    const est = picks.find((p) => p.job.id === "est")!;
    expect(est.why).not.toMatch(/Salary|180|225/);
    const [a, b] = deliveryJobs(picks, pool.estimates).sort((x, y) => x.title.localeCompare(y.title));
    expect(a).toMatchObject({ title: "Community Lead", salary: "$90k to $100k", salaryEstimate: null });
    expect(b).toMatchObject({ title: "Community Manager", salary: null, salaryEstimate: "est. $180k to $225k (web3.career estimate)" });
    const msg = { digestId: "dg_1", userId: "u", localDate: "2026-09-12", jobs: [a!, b!] };
    const tg = telegramText(msg, "https://nextcryptojob.xyz");
    expect(tg.match(/est\. \$180k to \$225k \(web3\.career estimate\)/g)).toHaveLength(1);
    expect(tg).not.toContain("$300k");
    expect(emailPayload(msg, NOW).jobs.map((j) => j.salary_estimate)).toEqual([null, "est. $180k to $225k (web3.career estimate)"]);
  });
});

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

describe("loadCrawlPool", () => {
  it("бере лише живі (бачені за 3 доби) з тегом web3 і опубліковані за 30 днів", async () => {
    const iso = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
    fake.add({ id: "live", title: "Solidity Engineer" });
    fake.add({ id: "gone", title: "Rust Engineer", fetchedAt: iso(4) });
    fake.add({ id: "nontag", title: "Backend Engineer", tags: ["engineering"] });
    fake.add({ id: "upper", title: "Backend Engineer", tags: ["WEB3"] });
    fake.add({ id: "old", title: "Go Engineer", postedAt: iso(40) });
    fake.add({ id: "undated", title: "Frontend Engineer", postedAt: null });
    const { jobs, stats } = await loadCrawlPool(readOnlyJobsDb(fake), NOW);
    expect(jobs.map((j) => j.id).sort()).toEqual(["live", "undated"]);
    expect(stats.dropped.tag).toBe(1); // LIKE без регістру пропустив "WEB3", точна перевірка ні
  });

  it("ATS: ще у фіді й до 90 днів, давніші за 30 рахуються в older; дошка лише 30; без дати вік від first_seen_at", async () => {
    const iso = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
    fake.add({ id: "ats60", title: "Solidity Engineer", source: "greenhouse:acme", postedAt: iso(60) });
    fake.add({ id: "ats100", title: "Rust Engineer", source: "greenhouse:acme", postedAt: iso(100) });
    fake.add({ id: "board40", title: "Go Engineer", source: "board:web3career", postedAt: iso(40) });
    fake.add({ id: "undated", title: "Frontend Engineer", source: "rippling:acme", postedAt: null, firstSeenAt: iso(45) });
    const { jobs, stats } = await loadCrawlPool(readOnlyJobsDb(fake), NOW);
    expect(jobs.map((j) => j.id).sort()).toEqual(["ats60", "undated"]);
    expect(stats).toMatchObject({ kept: 2, older: 2 });
    expect(jobs.find((j) => j.id === "undated")!.firstSeenAt).toBe(NOW.getTime() - 45 * 86_400_000);
  });

  it("чистить не-крипто компанії й назви та назви без нашої ролі", async () => {
    fake.add({ id: "a", title: "Expert Audio Transcriber, Bulgarian", company: "Perle", companyKey: "perle" });
    fake.add({ id: "b", title: "Customer Success Manager", company: "Notion", companyKey: "notion" });
    fake.add({ id: "c", title: "Robata Chef", company: "Katana" });
    fake.add({ id: "d", title: "Associate", company: "Katana" });
    fake.add({ id: "e", title: "Senior Protocol Engineer", company: "Katana" });
    const { jobs, stats } = await loadCrawlPool(readOnlyJobsDb(fake), NOW);
    expect(jobs.map((j) => j.id)).toEqual(["e"]);
    expect(stats).toMatchObject({ fetched: 5, kept: 1, dropped: { tag: 0, company: 2, title: 2 } });
  });

  it("гібрид з прапорцем remote стає не віддаленим, дати з ISO розбираються", async () => {
    fake.add({ id: "h", title: "Solidity Engineer", location: "New York - Hybrid", remote: true });
    const { jobs } = await loadCrawlPool(readOnlyJobsDb(fake), NOW);
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

describe("вакансія компанії", () => {
  const row = {
    id: "job_1", company_id: "co_1", company_name: "Acme Labs", title: " Solidity engineer ", roles: '["engineer"]',
    remote_mode: "remote,city", apply_url: "mailto:jobs@acme.io", city: "Lisbon", country: "PT", salary_min: 8000,
    salary_max: 10000, salary_currency: "eur", salary_period: "month", published_at: "2026-09-10 09:00:00",
  };

  it("веде на свою сторінку на сайті, а не прямо на apply_url компанії", () => {
    const job = companyJob(row, "https://nextcryptojob.xyz/")!;
    expect(job.url).toBe("https://nextcryptojob.xyz/jobs/job_1");
    expect(job).toMatchObject({ ref: "co:job_1", location: "Remote or Lisbon", remote: true, salary: { currency: "EUR", period: "month" } });
  });

  it("без apply_url чи ролей вакансії в пулі немає: сторінці нема куди вести", () => {
    expect(companyJob({ ...row, apply_url: null }, "https://nextcryptojob.xyz")).toBeNull();
    expect(companyJob({ ...row, roles: "[]" }, "https://nextcryptojob.xyz")).toBeNull();
  });
});
