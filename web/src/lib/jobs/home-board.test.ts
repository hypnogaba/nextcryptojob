import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readOnlyJobsDb, type JobsDb } from "@/lib/jobs-db";
import { addCompany, addSubscription, crmDb, run } from "@/test/crm-fixtures";
import { addPoolJob, jobsTestDb } from "@/test/jobs-db";
import type { TestDb } from "@/test/sqlite-d1";
import { roughCount } from "./instant";
import {
  homeBoard,
  homeStats,
  resetHomeBoard,
  TICKER_SIZE,
  tickerHref,
  tickerJobs,
  updatedAgo,
} from "./home-board";
import { resetCrawlPool, type PoolJob } from "./pool";

/**
 * Табло головної: лічильники чесні (униз, без дати не «нове»), стрічка лише з
 * зарплатою, одна вакансія на компанію, безпечні посилання; база вакансій не частіше
 * разу на 10 хвилин; без бази головна не падає.
 */

const NOW = new Date("2026-09-13T12:00:00Z");
const T = NOW.getTime();
const H = 3_600_000;

let n = 0;
function job(p: Partial<PoolJob> = {}): PoolJob {
  const id = `j${++n}`;
  return {
    jobId: `nr_${id}`,
    source: "crawl",
    title: "Protocol Engineer",
    company: `Company ${id}`,
    workMode: ["remote"],
    city: null,
    placeText: "Remote",
    salary: null,
    roles: ["engineer"],
    url: `https://boards.example.com/${id}`,
    postedAt: null,
    postedMs: T - 24 * H,
    haystack: "",
    companyKey: `company${id}`,
    location: "Remote",
    country: null,
    seenMs: T - 5 * H,
    dedupeKey: null,
    origin: "greenhouse:a",
    ...p,
  };
}
const usd = (min: number | null, max: number | null) => ({ min, max, currency: "USD", period: "year" as const });

describe("counters", () => {
  it("count live jobs, new this week, companies and jobs with a salary we would show", () => {
    const crawl = [
      job({ companyKey: "aave", salary: usd(150_000, 190_000), postedMs: T - 2 * 24 * H, origin: "greenhouse:aave" }),
      job({ companyKey: "aave", postedMs: T - 6.9 * 24 * H, origin: "greenhouse:aave" }),
      // Старше тижня, без дати, з датою в майбутньому: жодна з них не «нова».
      job({ companyKey: "lido", postedMs: T - 7.1 * 24 * H, origin: "ashby:lido" }),
      job({ companyKey: "kiln", postedMs: null }),
      job({ companyKey: "zora", postedMs: T + 2 * H }),
      // 1 000 у вилці заглушка, а не зарплата: не рахується, як і не показується.
      job({ companyKey: "phantom", salary: usd(1000, null), origin: null }),
    ];
    const company = [job({ source: "company", jobId: "job_acme", companyKey: "acme", postedMs: T - H, salary: usd(90_000, null), origin: null })];
    expect(homeStats(crawl, company, NOW)).toEqual({
      live: 7,
      // Дві Aave, Phantom (добу тому) і вакансія компанії.
      newThisWeek: 4,
      companies: 6,
      withSalary: 2,
      // greenhouse:aave, ashby:lido, greenhouse:a + наші вакансії компаній.
      sources: 4,
      // Вакансія компанії опублікована годину тому, скан бачив решту 5 годин тому.
      updatedMs: T - H,
    });
  });

  it("never take a time from the future as the last update", () => {
    const stats = homeStats([job({ seenMs: T + 10 * H }), job({ seenMs: T - 3 * H })], [], NOW);
    expect(stats.updatedMs).toBe(T - 3 * H);
    expect(homeStats([], [], NOW)).toMatchObject({ live: 0, companies: 0, sources: 0, updatedMs: null });
  });

  it("round down on the board, never up", () => {
    const shown = [0, 9, 99, 100, 101, 290, 299, 1000, 1243, 1299, 3100, 12_345].map(roughCount);
    expect(shown).toEqual(["0", "9", "99", "100", "100+", "290", "290+", "1,000", "1,200+", "1,200+", "3,100", "12,300+"]);
    // Число на табло без «+» і коми ніколи не більше справжнього.
    for (const [i, v] of [0, 9, 99, 100, 101, 290, 299, 1000, 1243, 1299, 3100, 12_345].entries()) {
      expect(Number(shown[i].replace(/[,+]/g, ""))).toBeLessThanOrEqual(v);
    }
  });

  it("say when the jobs were last updated, rounded down", () => {
    expect(updatedAgo(null, T)).toBeNull();
    expect(updatedAgo(T - 30_000, T)).toBe("just now");
    expect(updatedAgo(T + 60_000, T)).toBe("just now");
    expect(updatedAgo(T - 12.9 * 60_000, T)).toBe("12 min ago");
    expect(updatedAgo(T - 59.9 * 60_000, T)).toBe("59 min ago");
    expect(updatedAgo(T - 5.9 * H, T)).toBe("5 h ago");
    expect(updatedAgo(T - 47.9 * H, T)).toBe("47 h ago");
    expect(updatedAgo(T - 3.5 * 24 * H, T)).toBe("3 days ago");
  });
});

describe("ticker", () => {
  it("takes only jobs with a salary we would show, with a currency", () => {
    const jobs = tickerJobs([
      job({ title: "Paid", salary: usd(150_000, 190_000) }),
      job({ title: "No salary" }),
      job({ title: "Placeholder", salary: usd(1000, null) }),
      job({ title: "No currency", salary: { min: 150_000, max: null, currency: null, period: "year" } }),
      job({ title: "Monthly", salary: { min: 8000, max: 10_000, currency: "EUR", period: "month" } }),
    ]);
    expect(jobs.map((j) => [j.title, j.salary])).toEqual([
      ["Paid", "$150k to $190k"],
      ["Monthly", "€8k to €10k a month"],
    ]);
  });

  it("takes one job per company, freshest first, and dated jobs before undated ones", () => {
    const jobs = tickerJobs([
      job({ title: "Older Aave", companyKey: "aave", company: "Aave", postedMs: T - 48 * H, salary: usd(100_000, 120_000) }),
      job({ title: "Newer Aave", companyKey: "aave", company: "Aave", postedMs: T - 2 * H, salary: usd(100_000, 120_000) }),
      job({ title: "Undated", companyKey: "lido", postedMs: null, seenMs: T - H, salary: usd(100_000, 120_000) }),
      job({ title: "Dated", companyKey: "kiln", postedMs: T - 20 * 24 * H, salary: usd(100_000, 120_000) }),
    ]);
    expect(jobs.map((j) => j.title)).toEqual(["Newer Aave", "Dated", "Undated"]);
    expect(new Set(jobs.map((j) => j.company)).size).toBe(jobs.length);
  });

  it("mixes roles instead of showing only engineers", () => {
    const all = [
      ...Array.from({ length: 30 }, (_, i) => job({ roles: ["engineer"], postedMs: T - i * H, salary: usd(150_000, 190_000) })),
      job({ title: "Trader", roles: ["trader"], postedMs: T - 100 * H, salary: usd(120_000, 200_000) }),
      job({ title: "Designer", roles: ["designer"], postedMs: T - 200 * H, salary: usd(110_000, 150_000) }),
    ];
    const jobs = tickerJobs(all);
    expect(jobs).toHaveLength(TICKER_SIZE);
    expect(jobs.slice(0, 3).map((j) => j.title)).toEqual(["Protocol Engineer", "Trader", "Designer"]);
  });

  it("links only to http(s) boards, and to our own page for company jobs", () => {
    const pay = usd(150_000, 190_000);
    expect(tickerHref(job({ url: "javascript:alert(1)" }))).toBeNull();
    expect(tickerHref(job({ url: "mailto:jobs@example.com" }))).toBeNull();
    expect(tickerHref(job({ url: "not a url" }))).toBeNull();
    expect(tickerHref(job({ url: "https://boards.example.com/a?x=1" }))).toEqual({ href: "https://boards.example.com/a?x=1", external: true });
    expect(tickerHref(job({ source: "company", jobId: "job_a b", url: "mailto:x@example.com" }))).toEqual({ href: "/jobs/job_a%20b", external: false });
    const jobs = tickerJobs([job({ title: "Script", url: "javascript:alert(1)", salary: pay }), job({ title: "Ok", salary: pay })]);
    expect(jobs.map((j) => j.title)).toEqual(["Ok"]);
  });

  it("leaves out national boards and clips long text", () => {
    const pay = usd(150_000, 190_000);
    const jobs = tickerJobs([
      job({ title: "Інженер", country: "UA", salary: pay }),
      job({ title: "A".repeat(120), company: "B".repeat(80), location: "C".repeat(80), salary: pay }),
    ]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].title.length).toBeLessThanOrEqual(70);
    expect(jobs[0].company.length).toBeLessThanOrEqual(40);
    expect(jobs[0].place!.length).toBeLessThanOrEqual(36);
  });
});

describe("the board on the home page", () => {
  let nr: TestDb;
  let ours: TestDb;
  let reads: number;
  let jobs: () => JobsDb;
  const board = (j: () => JobsDb = jobs) => homeBoard({ db: () => ours.d1, env: {}, jobs: j, now: new Date() });
  const ago = (h: number) => new Date(Date.now() - h * H).toISOString();

  beforeEach(() => {
    resetCrawlPool();
    resetHomeBoard();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    nr = jobsTestDb();
    const f = ago(5);
    addPoolJob(nr.raw, { id: "a", title: "Protocol Engineer", company: "Aave", postedAt: ago(20), fetchedAt: f, salaryMin: 140_000, salaryMax: 170_000, currency: "USD" });
    addPoolJob(nr.raw, { id: "b", title: "Growth Marketing Lead", company: "Phantom", postedAt: ago(24 * 10), fetchedAt: f, source: "ashby:phantom" });
    addPoolJob(nr.raw, { id: "c", title: "Head Chef", company: "Food Co", postedAt: ago(4), fetchedAt: f });
    ours = crmDb();
    const co = addCompany(ours.raw, { name: "Acme Labs" });
    addSubscription(ours.raw, co);
    run(
      ours.raw,
      `INSERT INTO company_jobs (id, company_id, status, title, roles, remote_mode, apply_url, salary_min, salary_max, salary_currency,
                                 published_at, expires_at, created_via)
       VALUES ('job_acme', ?, 'open', 'Solidity Auditor', '["security_auditor"]', 'remote', 'https://acme.io/jobs', 120000, 150000, 'USD',
               datetime('now', '-1 day'), datetime('now', '+30 days'), 'web')`,
      co,
    );
    reads = 0;
    const base = readOnlyJobsDb(nr.d1);
    jobs = () => ({
      all: async <R,>(sql: string, ...params: unknown[]) => {
        reads++;
        return base.all<R>(sql, ...params);
      },
      first: base.first,
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("counts from the same pool as the digest and fills the ticker from it", async () => {
    const b = await board();
    expect(b.available).toBe(true);
    if (!b.available) return;
    // Два скановані рядки пройшли сито («Head Chef» ні) + вакансія компанії.
    expect(b.stats).toMatchObject({ live: 3, newThisWeek: 2, companies: 3, withSalary: 2, sources: 3 });
    // Aave опублікована 20 год тому, Acme добу тому: свіжіша перша.
    expect(b.ticker.map((j) => [j.title, j.href])).toEqual([
      ["Protocol Engineer", "https://boards.example.com/a"],
      ["Solidity Auditor", "/jobs/job_acme"],
    ]);
  });

  it("reads the jobs database at most once per 10 minutes", async () => {
    await board();
    await board();
    expect(reads).toBe(1);
  });

  it("still answers when the jobs database fails: no numbers, no ticker, no error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = () => ({ all: async () => Promise.reject(new Error("D1_ERROR: overloaded")), first: async () => null });
    expect(await board(broken)).toEqual({ available: false, stats: null, ticker: [] });
  });

  it("still answers when the Worker has no jobs database binding", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const unbound = () => {
      throw new Error("no binding");
    };
    expect(await board(unbound)).toMatchObject({ available: false });
  });

  it("keeps the scanned numbers when our own database fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const b = await homeBoard({
      db: () => {
        throw new Error("DB is not bound");
      },
      env: {},
      jobs,
      now: new Date(),
    });
    expect(b.available && b.stats.live).toBe(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("company jobs read failed"));
  });
});
