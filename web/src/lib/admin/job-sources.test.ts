import { beforeEach, describe, expect, it, vi } from "vitest";
import { readOnlyJobsDb, type JobsDb } from "@/lib/jobs-db";
import { addCompany, addSubscription, crmDb, run } from "@/test/crm-fixtures";
import { addCachedJob, addScanRun, addSource, jobsTestDb } from "@/test/jobs-db";
import {
  ago,
  cachedJobSourcesReport,
  describeSource,
  isStale,
  loadJobSourcesReport,
  pastScanSlots,
  resetJobSourcesCache,
  scannerMissed,
  SOURCES_SQL,
  sourcesParams,
  toJobSource,
  type JobSourcesReport,
  type SourceAggRow,
} from "./job-sources";

const NOW = new Date("2026-09-12T12:00:00.000Z"); // субота
const FRESH = "2026-09-12T04:35:00.000Z"; // сьогоднішній скан (щодня о 04:30 UTC)
const OLD = "2026-09-01T04:35:00.000Z"; // поза вікном у 3 дні
const H = 3_600_000;

/** База вакансій (схема db/jobs) з різними випадками; повертає базу для select. */
function seedJobs() {
  const t = jobsTestDb();
  const add = (j: Parameters<typeof addCachedJob>[1]) => addCachedJob(t.raw, j);
  // Компанія на ATS: дві живі (одна із зарплатою), одна поза вікном скану.
  add({ source: "greenhouse:coinbase", company: "Coinbase", fetchedAt: FRESH, salaryMin: 150_000 });
  add({ source: "greenhouse:coinbase", company: "Coinbase", fetchedAt: FRESH, postedAt: "2026-09-10T00:00:00Z" });
  add({ source: "greenhouse:coinbase", company: "Coinbase", fetchedAt: OLD });
  // Агрегатор з таблиці sources: одна web3 із зарплатою.
  add({ source: "aggregator:speedrun", fetchedAt: FRESH, company: "Anchorage", salaryMax: 200_000 });
  // Без жодної web3: тег лише схожий (сканер такого не пише, умова лишається запобіжником).
  add({ source: "board:odd", fetchedAt: FRESH, tags: ["web3ish", "remote"] });
  // Дошка: свіжа, але опублікована давно, тож не жива.
  add({ source: "board:web3career", fetchedAt: FRESH, postedAt: "2026-07-01T00:00:00Z" });
  // Дошка, яку востаннє бачив четверговий скан: у п'ятничному й суботньому її не було.
  // Застигла, але ще в 3-денному вікні живих.
  add({ source: "board:remote3", fetchedAt: "2026-09-10T04:40:00.000Z" });
  // Джерело лише з не-крипто компанією: web3 немає (сканер такі й не пише).
  add({ source: "ashby:perle", company: "Perle", companyKey: "perle", fetchedAt: FRESH });
  addSource(t.raw, { name: "board:web3career", label: "Web3.career", kind: "jsonld", feedUrl: "https://web3.career/", siteUrl: "https://web3.career" });
  addSource(t.raw, { name: "board:remote3", label: "Remote3", feedUrl: "https://www.remote3.co/api/rss", siteUrl: null });
  addSource(t.raw, { name: "aggregator:speedrun", label: "a16z speedrun", kind: "speedrun", feedUrl: "https://speedrun-talent-network.com/api/v1", siteUrl: "https://speedrun-talent-network.com" });
  addScanRun(t.raw, { id: "s1", startedAt: "2026-09-11T04:30:00.000Z" });
  addScanRun(t.raw, { id: "s2", startedAt: "2026-09-12T04:30:00.000Z", status: "partial" });
  // Розвідка пізніше за скан: «останній скан» бере лише kind = 'scan'.
  addScanRun(t.raw, { id: "d1", startedAt: "2026-09-12T05:30:00.000Z", kind: "discover" });
  return t;
}

describe("the aggregate query", () => {
  it("counts web3, live and salaried jobs per source with the digest's window and sieve", async () => {
    const { d1 } = seedJobs();
    const rows = await readOnlyJobsDb(d1).all<SourceAggRow>(SOURCES_SQL, ...sourcesParams(NOW));
    const by = Object.fromEntries(rows.map((r) => [r.source, r]));

    expect(Object.keys(by).sort()).toEqual(["aggregator:speedrun", "board:remote3", "board:web3career", "greenhouse:coinbase"]);
    expect(by["greenhouse:coinbase"]).toMatchObject({
      company: "Coinbase", web3_jobs: 3, live_jobs: 2, live_salary: 1, newest: FRESH, board_label: null,
    });
    expect(by["aggregator:speedrun"]).toMatchObject({ web3_jobs: 1, live_jobs: 1, live_salary: 1, board_label: "a16z speedrun" });
    // Опубліковано понад 30 днів тому: у базі є, у добірку не йде. Сайт дошки з site_url.
    expect(by["board:web3career"]).toMatchObject({ web3_jobs: 1, live_jobs: 0, board_label: "Web3.career", board_url: "https://web3.career" });
    // Без site_url лишається адреса стрічки (сторінка покаже її origin).
    expect(by["board:remote3"]).toMatchObject({ live_jobs: 1, board_url: "https://www.remote3.co/api/rss" });
    // Усі джерела бази, і ті, що без web3 (board:odd, ashby:perle).
    expect(rows.every((r) => r.all_sources === 6)).toBe(true);
    expect(rows[0]).toMatchObject({ last_scan_at: "2026-09-12T04:30:00.000Z", last_scan_status: "partial" });
    // Найбільше живих угорі.
    expect(rows[0]!.source).toBe("greenhouse:coinbase");
  });

  it("is a single read the jobs DB guard lets through", () => {
    const calls: unknown[][] = [];
    const binding = { prepare: (sql: string) => ({ bind: (...p: unknown[]) => (calls.push([sql, ...p]), { all: async () => ({ results: [] }) }) }) };
    return readOnlyJobsDb(binding as unknown as D1Database).all(SOURCES_SQL, ...sourcesParams(NOW)).then(() => {
      expect(calls).toHaveLength(1);
      expect(calls[0]!.slice(1)).toEqual([
        expect.stringMatching(/^\|perle\|crusoe\|.*\|bcg attorney search\|$/),
        "2026-09-09T12:00:00.000Z",
        "2026-08-13T12:00:00.000Z",
      ]);
    });
  });
});

function row(o: Partial<SourceAggRow> & { source: string }): SourceAggRow {
  return {
    company: null, web3_jobs: 1, live_jobs: 1, live_salary: 0, newest: FRESH, all_sources: 1,
    board_label: null, board_url: null, last_scan_at: null, last_scan_status: null, ...o,
  };
}

describe("source names and links", () => {
  it("links an ATS company to its job board and names it after the company", () => {
    expect(describeSource(row({ source: "greenhouse:coinbase", company: "Coinbase" }))).toEqual({
      name: "Coinbase", kind: "ats", via: "Greenhouse", url: "https://job-boards.greenhouse.io/coinbase",
    });
    expect(describeSource(row({ source: "breezy:zero-hash", company: null }))).toMatchObject({
      name: "zero-hash", url: "https://zero-hash.breezy.hr/",
    });
    expect(describeSource(row({ source: "ashby:Sui%20Foundation", company: "Sui Foundation" })).url)
      .toBe("https://jobs.ashbyhq.com/Sui%20Foundation");
    expect(describeSource(row({ source: "teamtailor:crossmint.na", company: "Crossmint" }))).toMatchObject({
      via: "Teamtailor", url: "https://crossmint.na.teamtailor.com/jobs",
    });
    expect(describeSource(row({ source: "lever_eu:aavelabs" }))).toMatchObject({ via: "Lever EU", url: "https://jobs.eu.lever.co/aavelabs" });
  });

  it("links a board to its site, not to its feed", () => {
    expect(describeSource(row({ source: "board:remote3", board_label: "Remote3", board_url: "https://www.remote3.co/api/rss" })))
      .toEqual({ name: "Remote3", kind: "board", via: "Job board", url: "https://www.remote3.co/" });
    expect(describeSource(row({ source: "board:jobstash" }))).toMatchObject({ name: "jobstash", url: null });
  });

  it("names aggregators from the sources table or the built-in list", () => {
    expect(describeSource(row({ source: "aggregator:speedrun", board_label: "a16z speedrun", board_url: "https://speedrun-talent-network.com" })))
      .toMatchObject({ name: "a16z speedrun", kind: "aggregator", url: "https://speedrun-talent-network.com/" });
    expect(describeSource(row({ source: "aggregator:superteam" }))).toMatchObject({ name: "Superteam Earn", url: "https://superteam.fun/earn" });
    expect(describeSource(row({ source: "aggregator:newthing" }))).toMatchObject({ name: "newthing", url: null });
  });

  it("never puts a non-http link from the DB into href", () => {
    expect(describeSource(row({ source: "board:x", board_label: "X", board_url: "data:text/html,hi" })).url).toBeNull();
    expect(describeSource(row({ source: "aggregator:x", board_label: "X", board_url: "javascript:alert(1)" })).url).toBeNull();
  });
});

describe("stale flag", () => {
  it("counts daily scans (04:30 UTC, weekends too) that should have run, not hours", () => {
    const iso = (at: string) => pastScanSlots(new Date(at), 2).map((t) => new Date(t).toISOString());
    expect(iso("2026-09-12T12:00:00Z")).toEqual(["2026-09-12T04:30:00.000Z", "2026-09-11T04:30:00.000Z"]); // субота
    expect(iso("2026-09-14T07:29:00Z")).toEqual(["2026-09-13T04:30:00.000Z", "2026-09-12T04:30:00.000Z"]); // понеділок, скан ще в запасі 3 год
    expect(iso("2026-09-14T07:30:00Z")).toEqual(["2026-09-14T04:30:00.000Z", "2026-09-13T04:30:00.000Z"]);
  });

  it("a source seen by yesterday's scan stays active; one missing two scans is stale, weekend or not", () => {
    const friday = Date.parse("2026-09-11T04:40:00Z");
    const thursday = Date.parse("2026-09-10T04:40:00Z");
    expect(isStale(friday, NOW)).toBe(false); // пропустила лише суботній
    expect(isStale(thursday, NOW)).toBe(true); // пропустила п'ятничний і суботній
    expect(isStale(Date.parse("2026-09-12T04:40:00Z"), new Date("2026-09-14T12:00:00Z"))).toBe(true); // неділя й понеділок без неї
    expect(isStale(null, NOW)).toBe(true);
  });

  it("calls the scanner late when today's scan is missing 3 h after 04:30 UTC, on any day", () => {
    const saturdayScan = Date.parse("2026-09-12T04:30:05Z");
    expect(scannerMissed(saturdayScan, new Date("2026-09-12T12:00:00Z"))).toBe(false);
    expect(scannerMissed(saturdayScan, new Date("2026-09-13T07:29:00Z"))).toBe(false); // неділя, ще в запасі
    expect(scannerMissed(saturdayScan, new Date("2026-09-13T07:30:00Z"))).toBe(true); // недільного немає
    expect(scannerMissed(Date.parse("2026-09-13T04:31:00Z"), new Date("2026-09-13T07:30:00Z"))).toBe(false);
    expect(scannerMissed(null, NOW)).toBe(true);
  });

  it("reads ISO and SQLite times alike", () => {
    // У суботу межа: п'ятничний скан (04:30 UTC, з годиною запасу на ранній старт).
    expect(toJobSource(row({ source: "lever:safe", newest: "2026-09-11T03:00:00.000Z" }), NOW)).toMatchObject({ stale: true });
    expect(toJobSource(row({ source: "lever:safe", newest: "2026-09-11 04:35:00" }), NOW)).toMatchObject({ stale: false });
    expect(toJobSource(row({ source: "lever:safe", newest: null }), NOW)).toMatchObject({ stale: true, newestAt: null });
  });

  it("says how long ago in words", () => {
    const t = NOW.getTime();
    expect(ago(t - 20_000, t)).toBe("just now");
    expect(ago(t - 7 * 60_000, t)).toBe("7 min ago");
    expect(ago(t - 5 * H, t)).toBe("5 h ago");
    expect(ago(t - 80 * H, t)).toBe("3 d ago");
  });
});

describe("loadJobSourcesReport", () => {
  let jobs: JobsDb;
  let main: ReturnType<typeof crmDb>;

  beforeEach(() => {
    jobs = readOnlyJobsDb(seedJobs().d1);
    main = crmDb();
    const paid = addCompany(main.raw, { name: "Paid Co" });
    addSubscription(main.raw, paid);
    const unpaid = addCompany(main.raw, { name: "Unpaid Co" });
    const job = (id: string, company: string, status: string, published: string | null, salary: number | null) =>
      run(main.raw,
        `INSERT INTO company_jobs (id, company_id, status, title, roles, created_via, salary_min, published_at,
                                   expires_at, apply_url)
         VALUES (?, ?, ?, 'Solidity engineer', '["engineering"]', 'web', ?, ?, datetime('now', '+30 days'),
                 'https://example.com/apply')`,
        id, company, status, salary, published);
    job("job_1", paid, "open", "2026-09-11 10:00:00", 120_000);
    job("job_2", paid, "open", "2026-09-12 09:00:00", null);
    job("job_3", unpaid, "open", "2026-09-12 11:00:00", null); // відкрита, але без доступу: не в добірці
    job("job_4", paid, "draft", null, null);
  });

  it("adds the company jobs row and the totals", async () => {
    const report = await loadJobSourcesReport(jobs, main.d1, NOW);
    expect(report.company).toEqual({
      openJobs: 3, liveJobs: 2, liveWithSalary: 1, newestAt: Date.parse("2026-09-12T11:00:00Z"),
    });
    expect(report.sources.map((s) => [s.key, s.stale])).toEqual([
      ["greenhouse:coinbase", false],
      ["aggregator:speedrun", false],
      ["board:remote3", true],
      ["board:web3career", false],
    ]);
    expect(report.totals).toEqual({
      liveJobs: 4 + 2, crawlLiveJobs: 4, companyLiveJobs: 2,
      activeSources: 3, staleSources: 1, allSources: 6,
      lastScan: { at: Date.parse("2026-09-12T04:30:00.000Z"), status: "partial" },
      scannerStale: false,
    });
    expect(report.computedAt).toBe(NOW.getTime());
  });

  it("warns that the scanner itself stopped when it missed a daily scan", async () => {
    // Вівторок 12:00: останній скан суботній, недільного, понеділкового й вівторкового немає.
    const later = new Date(NOW.getTime() + 3 * 24 * H);
    const report = await loadJobSourcesReport(jobs, main.d1, later);
    expect(report.totals.scannerStale).toBe(true);
    expect(report.totals.staleSources).toBe(report.sources.length);
    expect(report.totals.crawlLiveJobs).toBe(0);
  });
});

describe("cache", () => {
  beforeEach(() => resetJobSourcesCache());

  const fake = (at: Date): JobSourcesReport => ({
    sources: [], company: { openJobs: 0, liveJobs: 0, liveWithSalary: 0, newestAt: null },
    totals: {
      liveJobs: 0, crawlLiveJobs: 0, companyLiveJobs: 0, activeSources: 0, staleSources: 0,
      allSources: 0, lastScan: null, scannerStale: true,
    },
    computedAt: at.getTime(),
  });

  it("reuses a report for 10 minutes and then recounts", async () => {
    const load = vi.fn(async (now: Date) => fake(now));
    const first = await cachedJobSourcesReport(load, NOW);
    await expect(cachedJobSourcesReport(load, new Date(NOW.getTime() + 9 * 60_000 + 59_000))).resolves.toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
    const next = await cachedJobSourcesReport(load, new Date(NOW.getTime() + 10 * 60_000));
    expect(load).toHaveBeenCalledTimes(2);
    expect(next.computedAt).toBe(NOW.getTime() + 10 * 60_000);
  });

  it("does not cache a failure", async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("D1 overloaded"))
      .mockImplementation(async (now: Date) => fake(now));
    await expect(cachedJobSourcesReport(load, NOW)).rejects.toThrow("D1 overloaded");
    await expect(cachedJobSourcesReport(load, NOW)).resolves.toMatchObject({ computedAt: NOW.getTime() });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
