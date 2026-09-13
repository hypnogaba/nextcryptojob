import { beforeEach, describe, expect, it, vi } from "vitest";
import { readOnlyJobsDb, type JobsDb } from "@/lib/jobs-db";
import { addCompany, addSubscription, crmDb, run } from "@/test/crm-fixtures";
import { addCachedJob, nextroleJobsDb } from "@/test/nextrole-jobs-db";
import {
  ago,
  cachedJobSourcesReport,
  describeSource,
  isStale,
  loadJobSourcesReport,
  resetJobSourcesCache,
  SOURCES_SQL,
  sourcesParams,
  toJobSource,
  type JobSourcesReport,
  type SourceAggRow,
} from "./job-sources";

const NOW = new Date("2026-09-12T12:00:00.000Z");
const FRESH = "2026-09-12T03:00:00.000Z"; // сьогоднішній скан
const OLD = "2026-09-01T03:00:00.000Z"; // поза вікном у 3 дні
const H = 3_600_000;

/** Кеш NextRole з різними випадками; повертає базу для select. */
function seedNextrole() {
  const t = nextroleJobsDb();
  const add = (j: Parameters<typeof addCachedJob>[1]) => addCachedJob(t.raw, j);
  // Компанія на ATS: дві живі (одна із зарплатою), одна поза вікном скану.
  add({ source: "greenhouse:coinbase", company: "Coinbase", fetchedAt: FRESH, salaryMin: 150_000 });
  add({ source: "greenhouse:coinbase", company: "Coinbase", fetchedAt: FRESH, postedAt: "2026-09-10T00:00:00Z" });
  add({ source: "greenhouse:coinbase", company: "Coinbase", fetchedAt: OLD });
  // Агрегатор: одна web3, одна ні.
  add({ source: "aggregator:remoteok", fetchedAt: FRESH, company: "Solana Labs", salaryMax: 200_000 });
  add({ source: "aggregator:remoteok", fetchedAt: FRESH, tags: ["remote"] });
  // Без жодної web3: тег лише схожий, у звіт не йде, але рахується серед усіх джерел.
  add({ source: "aggregator:remotive", fetchedAt: FRESH, tags: ["web3ish", "remote"] });
  // Дошка: свіжа, але опублікована давно, тож не жива.
  add({ source: "board:global-web3career", fetchedAt: FRESH, postedAt: "2026-07-01T00:00:00Z" });
  // Дошка країни: скан бачив її 60 год тому. Застигла, але ще в 3-денному вікні живих.
  add({ source: "board:dou-blockchain", fetchedAt: "2026-09-10T00:00:00.000Z" });
  // Getro: одна крипто, одна від не-крипто компанії з тегом web3.
  add({ source: "getro:858", company: "Phantom", fetchedAt: FRESH });
  add({ source: "getro:858", company: "Perle", companyKey: "perle", fetchedAt: FRESH });
  // Джерело лише з не-крипто компанією: web3 немає.
  add({ source: "ashby:perle", company: "Perle", companyKey: "perle", fetchedAt: FRESH });
  t.raw.exec(`
    INSERT INTO country_boards (id, country, name, label, feed_url) VALUES
      ('b1', '*', 'board:global-web3career', 'Web3.career', 'https://web3.career/feed.xml'),
      ('b2', 'UA', 'board:dou-blockchain', 'DOU · Blockchain', 'https://jobs.dou.ua/vacancies/feeds/?category=Blockchain');
    INSERT INTO getro_collections (id, collection_id, label, url) VALUES ('g1', 858, 'Solana', 'https://jobs.solana.com/jobs');
    INSERT INTO scan_runs (id, started_at, status) VALUES
      ('s1', '2026-09-11T03:00:00.000Z', 'ok'), ('s2', '2026-09-12T03:00:00.000Z', 'short');
  `);
  return t;
}

describe("the aggregate query", () => {
  it("counts web3, live and salaried jobs per source with the digest's window and sieve", async () => {
    const { d1 } = seedNextrole();
    const rows = await readOnlyJobsDb(d1).all<SourceAggRow>(SOURCES_SQL, ...sourcesParams(NOW));
    const by = Object.fromEntries(rows.map((r) => [r.source, r]));

    expect(Object.keys(by).sort()).toEqual([
      "aggregator:remoteok", "board:dou-blockchain", "board:global-web3career", "getro:858", "greenhouse:coinbase",
    ]);
    expect(by["greenhouse:coinbase"]).toMatchObject({
      company: "Coinbase", web3_jobs: 3, live_jobs: 2, live_salary: 1, newest: FRESH,
    });
    expect(by["aggregator:remoteok"]).toMatchObject({ web3_jobs: 1, live_jobs: 1, live_salary: 1 });
    // Опубліковано понад 30 днів тому: у кеші є, у добірку не йде.
    expect(by["board:global-web3career"]).toMatchObject({ web3_jobs: 1, live_jobs: 0, board_label: "Web3.career" });
    expect(by["board:dou-blockchain"]).toMatchObject({ live_jobs: 1, board_country: "UA" });
    // Perle з тегом web3 відсіяна, як у engine clean.ts.
    expect(by["getro:858"]).toMatchObject({ web3_jobs: 1, live_jobs: 1, getro_label: "Solana" });
    // Усі джерела кешу, і ті, що без web3 (remotive, ashby:perle).
    expect(rows.every((r) => r.all_sources === 7)).toBe(true);
    expect(rows[0]).toMatchObject({ last_scan_at: "2026-09-12T03:00:00.000Z", last_scan_status: "short" });
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
    board_label: null, board_url: null, board_country: null, getro_label: null, getro_url: null,
    last_scan_at: null, last_scan_status: null, ...o,
  };
}

describe("source names and links", () => {
  it("links an ATS company to its job board and names it after the company", () => {
    expect(describeSource(row({ source: "greenhouse:coinbase", company: "Coinbase" }))).toEqual({
      name: "Coinbase", kind: "ats", via: "Greenhouse", url: "https://job-boards.greenhouse.io/coinbase", country: null,
    });
    expect(describeSource(row({ source: "breezy:zero-hash", company: null }))).toMatchObject({
      name: "zero-hash", url: "https://zero-hash.breezy.hr/",
    });
    // Workday без сервера й сайту: назва є, посилання немає.
    expect(describeSource(row({ source: "workday:acme" })).url).toBeNull();
  });

  it("links a board to its site, not to its feed, and keeps a country board's country", () => {
    expect(describeSource(row({
      source: "board:dou-blockchain", board_label: "DOU · Blockchain", board_country: "UA",
      board_url: "https://jobs.dou.ua/vacancies/feeds/?category=Blockchain",
    }))).toEqual({ name: "DOU · Blockchain", kind: "board", via: "Job board", url: "https://jobs.dou.ua/", country: "UA" });
    expect(describeSource(row({ source: "board:global-jobstash", board_label: "JobStash", board_country: "*", board_url: "https://jobstash.xyz/" })))
      .toMatchObject({ country: null, url: "https://jobstash.xyz/" });
  });

  it("names Getro collections and aggregators, and falls back when the directory has no row", () => {
    expect(describeSource(row({ source: "getro:858", getro_label: "Solana", getro_url: "https://jobs.solana.com/jobs" })))
      .toMatchObject({ name: "Solana", via: "Getro", url: "https://jobs.solana.com/jobs" });
    expect(describeSource(row({ source: "getro:1000", getro_label: "Canapi Ventures", getro_url: null })).url)
      .toBe("https://getro.com");
    expect(describeSource(row({ source: "getro:77" })).name).toBe("Getro collection 77");
    expect(describeSource(row({ source: "aggregator:remoteok" }))).toMatchObject({ name: "Remote OK", url: "https://remoteok.com" });
    expect(describeSource(row({ source: "aggregator:wwr-programming" }))).toMatchObject({
      name: "We Work Remotely (programming)", url: "https://weworkremotely.com",
    });
    expect(describeSource(row({ source: "aggregator:newthing" }))).toMatchObject({ name: "newthing", url: null });
  });

  it("never puts a non-http link from the shared DB into href", () => {
    expect(describeSource(row({ source: "getro:1", getro_label: "X", getro_url: "javascript:alert(1)" })).url)
      .toBe("https://getro.com");
    expect(describeSource(row({ source: "board:x", board_label: "X", board_url: "data:text/html,hi" })).url).toBeNull();
  });
});

describe("stale flag", () => {
  it("flags a source the scan has not seen for more than 48 h, or ever", () => {
    expect(isStale(NOW.getTime() - 47 * H, NOW)).toBe(false);
    expect(isStale(NOW.getTime() - 48 * H, NOW)).toBe(false);
    expect(isStale(NOW.getTime() - 48 * H - 1, NOW)).toBe(true);
    expect(isStale(null, NOW)).toBe(true);
  });

  it("reads NextRole ISO and our SQLite times alike", () => {
    expect(toJobSource(row({ source: "lever:safe", newest: "2026-09-10T11:00:00.000Z" }), NOW)).toMatchObject({ stale: true });
    expect(toJobSource(row({ source: "lever:safe", newest: "2026-09-10 13:00:00" }), NOW)).toMatchObject({ stale: false });
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
    jobs = readOnlyJobsDb(seedNextrole().d1);
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
      ["aggregator:remoteok", false],
      ["board:dou-blockchain", true],
      ["getro:858", false],
      ["board:global-web3career", false],
    ]);
    expect(report.totals).toEqual({
      liveJobs: 5 + 2, nextroleLiveJobs: 5, companyLiveJobs: 2,
      activeSources: 4, staleSources: 1, allNextroleSources: 7,
      lastScan: { at: Date.parse("2026-09-12T03:00:00.000Z"), status: "short" },
      scannerStale: false,
    });
    expect(report.computedAt).toBe(NOW.getTime());
  });

  it("warns that the scanner itself stopped when its last run is over 48 h old", async () => {
    const later = new Date(NOW.getTime() + 3 * 24 * H);
    const report = await loadJobSourcesReport(jobs, main.d1, later);
    expect(report.totals.scannerStale).toBe(true);
    expect(report.totals.staleSources).toBe(report.sources.length);
    expect(report.totals.nextroleLiveJobs).toBe(0);
  });
});

describe("cache", () => {
  beforeEach(() => resetJobSourcesCache());

  const fake = (at: Date): JobSourcesReport => ({
    sources: [], company: { openJobs: 0, liveJobs: 0, liveWithSalary: 0, newestAt: null },
    totals: {
      liveJobs: 0, nextroleLiveJobs: 0, companyLiveJobs: 0, activeSources: 0, staleSources: 0,
      allNextroleSources: 0, lastScan: null, scannerStale: true,
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
