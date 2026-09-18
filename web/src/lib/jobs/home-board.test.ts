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
  homeLists,
  TICKER_SIZE,
  TODAY_SIZE,
  tickerHref,
  tickerJobs,
  todaysJobs,
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
    firstSeenMs: null,
    dedupeKey: null,
    origin: "greenhouse:a",
    salaryEstimate: null,
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

  it("live counts every open job in the pool; new this week goes by posting date, else by first seen", () => {
    const crawl = [
      // Ще відкрита у фіді роботодавця, опублікована 60 днів тому: жива, але не нова.
      job({ companyKey: "kraken", postedMs: T - 60 * 24 * H, firstSeenMs: T - 2 * 24 * H }),
      // Без дати публікації: нова, якщо скан уперше побачив її цього тижня.
      job({ companyKey: "rippling-co", postedMs: null, firstSeenMs: T - 3 * 24 * H }),
      job({ companyKey: "bamboo-co", postedMs: null, firstSeenMs: T - 10 * 24 * H }),
    ];
    expect(homeStats(crawl, [], NOW)).toMatchObject({ live: 3, newThisWeek: 1 });
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
    expect(tickerHref(job({ url: "https://boards.example.com/a?x=1" }))).toEqual({
      href: "https://boards.example.com/a?x=1", external: true, rel: "noopener noreferrer nofollow", via: null });
    expect(tickerHref(job({ source: "company", jobId: "job_a b", url: "mailto:x@example.com" }))).toEqual({
      href: "/jobs/job_a%20b", external: false, rel: null, via: null });
    const jobs = tickerJobs([job({ title: "Script", url: "javascript:alert(1)", salary: pay }), job({ title: "Ok", salary: pay })]);
    expect(jobs.map((j) => j.title)).toEqual(["Ok"]);
  });

  it("web3.career: apply_url byte for byte, a followed link with the referrer, web3.career named", () => {
    const pay = usd(150_000, 190_000);
    // Рядки, які new URL().toString() переписав би (регістр хоста, порт 443, крапки в шляху): лишаються як є.
    for (const apply of [
      "https://web3.career/r/=cTMxEDN__U4HFyv",
      "https://web3.career/r/wczNxUTM__U4HFyv?utm_source=w3c&ref=U4HFyv&b=2&a=1",
      "https://Web3.Career:443/r/./x__U4HFyv?q=a b".replace(" ", "%20"),
    ]) {
      expect(tickerHref(job({ url: apply }))).toEqual({ href: apply, external: true, rel: "noopener", via: "web3.career" });
    }
    const [t] = tickerJobs([job({ url: "https://web3.career/r/wczNxUTM__U4HFyv", salary: pay })]);
    expect(t).toMatchObject({ href: "https://web3.career/r/wczNxUTM__U4HFyv", rel: "noopener", via: "web3.career" });
  });

  it("a web3.career estimate: never counted as a salary, in the ticker only after real salaries and marked as an estimate", () => {
    const est = { ...usd(180_000, 225_000), by: "web3.career" };
    const w3 = (p: Partial<PoolJob>) => job({ url: "https://web3.career/r/x__U4HFyv", origin: "board:web3career", salaryEstimate: est, ...p });
    // Лічильник «з зарплатою» оцінки не бачить.
    expect(homeStats([w3({}), job({ salary: usd(100_000, 120_000) })], [], NOW).withSalary).toBe(1);
    // Роль лише з оцінкою (Community) не зникає; оцінка після всіх вакансій із зарплатою у своїй ролі.
    const jobs = tickerJobs([
      w3({ title: "Community Manager", roles: ["community"], postedMs: T - H }),
      w3({ title: "Rust Engineer (est)", postedMs: T - H }),
      job({ title: "Solidity Engineer", salary: usd(150_000, 190_000), postedMs: T - 48 * H }),
    ]);
    expect(jobs.map((j) => [j.title, j.salary, j.estimate])).toEqual([
      ["Solidity Engineer", "$150k to $190k", false],
      ["Community Manager", "est. $180k to $225k (web3.career estimate)", true],
      ["Rust Engineer (est)", "est. $180k to $225k (web3.career estimate)", true],
    ]);
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

describe("today's 5 on the home page", () => {
  const pay = usd(150_000, 190_000);
  const engineers = (k: number, p: Partial<PoolJob> = {}) =>
    Array.from({ length: k }, (_, i) => job({ title: `Engineer ${i}`, postedMs: T - (i + 1) * H, salary: pay, ...p }));

  it("takes the 5 freshest remote engineer jobs with an employer salary, one per company", () => {
    const all = [
      ...engineers(6),
      // Свіжіші, але не підходять: у місті, інша роль, лише оцінка дошки, та сама компанія.
      job({ title: "City", workMode: ["city"], postedMs: T - 0.1 * H, salary: pay }),
      job({ title: "Trader", roles: ["trader"], postedMs: T - 0.2 * H, salary: pay }),
      job({ title: "Estimate", postedMs: T - 0.3 * H, salaryEstimate: { ...pay, by: "web3.career" } }),
    ];
    const today = todaysJobs(all);
    expect(today.role).toBe("engineer");
    expect(today.jobs.map((j) => j.title)).toEqual(["Engineer 0", "Engineer 1", "Engineer 2", "Engineer 3", "Engineer 4"]);
    const same = todaysJobs([job({ companyKey: "aave", salary: pay, postedMs: T - H }), ...engineers(5, { companyKey: "aave" })]);
    expect(same.role).toBeNull();
  });

  it("falls back to the ticker's mix of roles, without the engineer label, when fewer than 5 fit", () => {
    const today = todaysJobs([...engineers(2), job({ title: "Trader", roles: ["trader"], salary: pay })]);
    expect(today.role).toBeNull();
    expect(today.jobs.map((j) => j.title)).toEqual(["Engineer 0", "Trader", "Engineer 1"]);
  });

  it("keeps the example jobs out of the ticker", () => {
    const { today, ticker } = homeLists([...engineers(8), job({ title: "Trader", roles: ["trader"], salary: pay })]);
    expect(today.jobs).toHaveLength(TODAY_SIZE);
    const shown = new Set(today.jobs.map((j) => j.ref));
    expect(ticker.some((j) => shown.has(j.ref))).toBe(false);
    expect(ticker.map((j) => j.title)).toEqual(["Engineer 5", "Trader", "Engineer 6", "Engineer 7"]);
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

  it("a new isolate takes the board from the edge cache instead of reading the database again", async () => {
    // Пам'ять ізолята живе, поки живе ізолят. Кеш краю спільний для колонії, тож холодний
    // ізолят не повторює читання пулу (замір 18.09: воно коштувало 1 до 2,4 с на першому байті).
    const store = new Map<string, Response>();
    vi.stubGlobal("caches", {
      default: {
        match: async (k: string) => store.get(k)?.clone(),
        put: async (k: string, r: Response) => void store.set(k, r.clone()),
      },
    } as unknown as CacheStorage);

    const first = await board();
    const afterFirst = reads;
    expect(afterFirst).toBeGreaterThan(0);
    expect(store.size).toBe(1);

    resetHomeBoard();
    resetCrawlPool();
    const second = await board();
    expect(reads).toBe(afterFirst);
    expect(second).toEqual(first);
    vi.unstubAllGlobals();
  });

  it("counts from the same pool as the digest and fills the example list from it", async () => {
    const b = await board();
    expect(b.available).toBe(true);
    if (!b.available) return;
    // Два скановані рядки пройшли сито («Head Chef» ні) + вакансія компанії.
    expect(b.stats).toMatchObject({ live: 3, newThisWeek: 2, companies: 3, withSalary: 2, sources: 3 });
    // Віддалених інженерів менше п'яти: приклад бере зі стрічки різні ролі, без підпису «engineer».
    // Aave опублікована 20 год тому, Acme добу тому: свіжіша перша.
    expect(b.today.role).toBeNull();
    expect(b.today.jobs.map((j) => [j.title, j.href])).toEqual([
      ["Protocol Engineer", "https://boards.example.com/a"],
      ["Solidity Auditor", "/jobs/job_acme"],
    ]);
    // Що вже в прикладі, стрічка не повторює.
    expect(b.ticker).toEqual([]);
  });

  it("reads the jobs database at most once per 10 minutes", async () => {
    await board();
    await board();
    expect(reads).toBe(1);
  });

  it("still answers when the jobs database fails: no numbers, no ticker, no error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = () => ({ all: async () => Promise.reject(new Error("D1_ERROR: overloaded")), first: async () => null });
    expect(await board(broken)).toEqual({ available: false, stats: null, today: null, ticker: [] });
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
