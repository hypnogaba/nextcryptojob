import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as engineJobs from "../../../../engine/src/digest/jobs";
import * as engineFit from "../../../../engine/src/digest/fit";
import * as engineMatch from "../../../../engine/src/digest/match";
import { readFileSync } from "node:fs";
import { readOnlyJobsDb, type JobsDb } from "@/lib/jobs-db";
import { addCompany, addSubscription, crmDb, run } from "@/test/crm-fixtures";
import { addPoolJob, jobsTestDb } from "@/test/jobs-db";
import type { TestDb } from "@/test/sqlite-d1";
import { homeStats } from "./home-board";
import {
  type BriefRow,
  checkedIn,
  instantMatches,
  profileOf,
  roughCount,
} from "./instant";
import { resetCompanyProfiles } from "./companies";
import { crawlPool, POOL_SQL, POOL_READ_SQL, resetCrawlPool } from "./pool";

/**
 * «Jobs for you now»: ті самі вакансії й той самий порядок, що вибрала б щоденна добірка
 * engine; причина, коли нічого не підійшло; кількість без прикрашання.
 */

const NOW = new Date("2026-09-13T12:00:00Z");
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

let nr: TestDb;
let ours: TestDb;
let reads: number;
let jobs: () => JobsDb;

/**
 * Живий пул з тими пастками, які добірка обходить: одна компанія двічі, «Hybrid», нац. дошка, не наша роль,
 * старе: з фіду роботодавця (ATS) 40 днів ще відкрите й лише добирає, з дошки 40 днів і з ATS 100 днів не живі.
 */
function seed(raw: DatabaseSync) {
  const f = ago(2);
  addPoolJob(raw, { id: "e1", title: "Senior Solidity Engineer", company: "Aave", postedAt: ago(24), fetchedAt: f, salaryMin: 150_000, salaryMax: 180_000, currency: "USD" });
  addPoolJob(raw, { id: "e2", title: "Protocol Engineer", company: "Aave", postedAt: ago(10), fetchedAt: f });
  addPoolJob(raw, { id: "e3", title: "Backend Engineer", company: "Lido", location: "Lisbon, Portugal", remote: false, postedAt: ago(48), fetchedAt: f, source: "ashby:lido" });
  addPoolJob(raw, { id: "e4", title: "Rust Engineer", company: "Solana Labs", location: "New York - Hybrid", remote: true, postedAt: ago(5), fetchedAt: f });
  addPoolJob(raw, { id: "e5", title: "Smart Contract Engineer", company: "Kraken", country: "DE", postedAt: ago(3), fetchedAt: f, source: "board:de-web3" });
  addPoolJob(raw, { id: "e6", title: "Frontend Engineer", company: "Uniswap", postedAt: null, fetchedAt: f, salaryMin: 90_000, currency: "EUR" });
  addPoolJob(raw, { id: "t1", title: "Crypto Trader", company: "Wintermute", postedAt: ago(30), fetchedAt: f, source: "ashby:wintermute" });
  addPoolJob(raw, { id: "b1", title: "BD Lead", company: "Phantom", postedAt: ago(20), fetchedAt: f, salaryMin: 1000, currency: "USD" });
  addPoolJob(raw, { id: "d1", title: "Product Designer", company: "Lido", location: "Lisbon", remote: false, postedAt: ago(8), fetchedAt: f, source: "ashby:lido" });
  addPoolJob(raw, { id: "old", title: "Solidity Engineer", company: "Old Co", postedAt: ago(24 * 40), fetchedAt: f });
  addPoolJob(raw, { id: "oldboard", title: "Solidity Engineer", company: "Board Co", postedAt: ago(24 * 40), fetchedAt: f, source: "board:web3career" });
  addPoolJob(raw, { id: "ancient", title: "Solidity Engineer", company: "Ancient Co", postedAt: ago(24 * 100), fetchedAt: f });
  addPoolJob(raw, { id: "chef", title: "Head Chef", company: "Food Co", postedAt: ago(4), fetchedAt: f });
}

function seedCompanyJob(raw: DatabaseSync) {
  const co = addCompany(raw, { name: "Acme Labs" });
  addSubscription(raw, co);
  run(
    raw,
    `INSERT INTO company_jobs (id, company_id, status, title, roles, remote_mode, city, apply_url, published_at, expires_at, created_via)
     VALUES ('job_acme', ?, 'open', 'Solidity Auditor', '["security_auditor","engineer"]', 'remote,city', 'Lisbon',
             'https://acme.io/jobs', datetime('now', '-1 day'), datetime('now', '+30 days'), 'web')`,
    co,
  );
}

beforeEach(() => {
  resetCrawlPool();
  resetCompanyProfiles();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  nr = jobsTestDb();
  seed(nr.raw);
  ours = crmDb();
  seedCompanyJob(ours.raw);
  reads = 0;
  const base = readOnlyJobsDb(nr.d1);
  jobs = () => ({
    all: async <T,>(sql: string, ...params: unknown[]) => {
      reads++;
      return base.all<T>(sql, ...params);
    },
    first: base.first,
  });
});
afterEach(() => vi.restoreAllMocks());

const brief = (o: Omit<Partial<BriefRow>, "roles"> & { roles: string[] }): BriefRow => ({
  remote_mode: "remote",
  city: null,
  salary_min: null,
  salary_currency: null,
  ...o,
  roles: JSON.stringify(o.roles),
});

const deps = () => ({ db: ours.d1, env: {}, jobs, now: NOW });

/** Що вибрала б добірка engine: її власний пул з тих самих рядків, її selectJobs і її пояснення (fit.ts). */
function engineChoice(b: BriefRow, exclude: Set<string>) {
  const rows = nr.raw.prepare(engineJobs.POOL_SQL).all(...engineJobs.poolParams(NOW)) as never[];
  const crawl = rows.flatMap((r) => {
    const x = engineJobs.crawlJob(r);
    return "job" in x ? [x.job] : [];
  });
  const company = (ours.raw.prepare("SELECT * FROM company_jobs_live").all() as never[])
    .map((r) => engineJobs.companyJob(r, "https://nextcryptojob.xyz"))
    .filter((j) => j !== null);
  return engineMatch
    .selectJobs({ crawl, company }, profileOf(b), { now: NOW, exclude })
    .map((p) => ({ ref: p.job.ref, why: engineFit.fitLine(p, profileOf(b), { words: null, scores: {} }, NOW) }));
}

describe("Jobs for you now", () => {
  it("picks exactly what the daily digest would pick, for many briefs", async () => {
    const briefs = [
      brief({ roles: ["engineer"] }),
      brief({ roles: ["engineer"], remote_mode: "city", city: "Lisbon" }),
      brief({ roles: ["engineer", "trader"], remote_mode: "remote,city", city: " Lisbon, Portugal ", salary_min: 160_000, salary_currency: "USD" }),
      brief({ roles: ["bd", "trader", "designer"], salary_min: 50_000, salary_currency: "EUR" }),
      brief({ roles: ["security_auditor"] }),
    ];
    for (const b of briefs) {
      for (const exclude of [new Set<string>(), new Set(["nr:e2", "co:job_acme"])]) {
        const now = await instantMatches(deps(), b, exclude);
        const expected = engineChoice(b, exclude);
        if (exclude.size === 0) expect(expected.length).toBeGreaterThan(0);
        expect(now.state === "ok" ? now.jobs.map((j) => ({ ref: j.ref, why: j.why })) : []).toEqual(expected);
      }
    }
  });

  it("one job per company, only the person's roles, nothing already sent", async () => {
    const now = await instantMatches(deps(), brief({ roles: ["engineer"] }), new Set(["nr:e2"]));
    expect(now.state).toBe("ok");
    if (now.state !== "ok") return;
    const refs = now.jobs.map((j) => j.ref);
    // Вакансія компанії першою (не більше однієї), далі скановані за свіжістю (без дати публікації
    // рахується, коли скан уперше побачив: e6 2 год тому); Aave лише раз, і не надіслана e2. «Hybrid» (e4)
    // і національна дошка (e5) не віддалені, Lisbon (e3) не для віддаленої анкети. Свіжих лише три,
    // тож добирає ще відкрита вакансія з фіду роботодавця (old, 40 днів), і пояснення це каже;
    // та сама давнина з дошки (oldboard) і 100 днів з ATS (ancient) не живі.
    expect(refs).toEqual(["co:job_acme", "nr:e6", "nr:e1", "nr:old"]);
    expect(now.jobs[3]!.why).toBe("Matches your Engineer role. Remote, as you asked. Still open, posted 5 weeks ago.");
    expect(now.jobs[3]).toMatchObject({ reasons: ["Matches your Engineer role.", "Remote, as you asked."], note: "Still open, posted 5 weeks ago." });
    expect(now.jobs[0]).toMatchObject({ url: "/jobs/job_acme", postedBy: "Acme Labs", location: "Remote or Lisbon" });
    expect(now.jobs[2]).toMatchObject({ company: "Aave", salary: "$150k to $180k", url: "https://boards.example.com/e1" });
    expect(now.jobs.every((j) => j.why.startsWith("Matches your Engineer role."))).toBe(true);
  });

  it("the preferences decide: a city brief sees the city job, a remote brief does not", async () => {
    const city = await instantMatches(deps(), brief({ roles: ["designer"], remote_mode: "city", city: "lisboa" }), new Set());
    expect(city).toMatchObject({ state: "ok", jobs: [{ ref: "nr:d1", why: "Matches your Designer role. In lisboa, where you want to work." }] });
    const remote = await instantMatches(deps(), brief({ roles: ["designer"] }), new Set());
    expect(remote).toEqual({ state: "none", reason: { kind: "remote_only", inCities: 1 } });
  });

  it("says why nothing matched", async () => {
    const reason = async (b: BriefRow, exclude = new Set<string>()) => {
      const now = await instantMatches(deps(), b, exclude);
      return now.state === "none" ? now.reason : now;
    };
    expect(await reason(brief({ roles: [] }))).toEqual({ kind: "no_roles" });
    expect(await reason(brief({ roles: ["legal_compliance"] }))).toEqual({ kind: "no_role_jobs", roles: ["legal_compliance"] });
    expect(await reason(brief({ roles: ["engineer"], remote_mode: "city", city: "Berlin" }))).toEqual({
      kind: "city_only",
      city: "Berlin",
      remote: 5,
    });
    expect(await reason(brief({ roles: ["trader"] }), new Set(["nr:t1"]))).toEqual({ kind: "all_sent" });
  });

  it("does not read the jobs database for a person without roles", async () => {
    await instantMatches(deps(), brief({ roles: [] }), new Set());
    expect(reads).toBe(0);
  });

  it("says the jobs are unavailable when the jobs database fails, and still lists nothing wrong", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = () => ({ all: async () => Promise.reject(new Error("D1_ERROR: overloaded")), first: async () => null });
    expect(await instantMatches({ ...deps(), jobs: broken }, brief({ roles: ["engineer"] }), new Set())).toEqual({ state: "unavailable" });
  });

  it("builds the brief like the engine does (profileOf in engine/src/digest/schedule.ts)", () => {
    // Текстом, не імпортом: schedule.ts тягне мережевий код engine, якого web не має.
    const body = (path: string) => {
      const src = readFileSync(new URL(path, import.meta.url), "utf8");
      const start = src.indexOf("{\n", src.indexOf("export function profileOf("));
      return src.slice(start, src.indexOf("\n}\n", start));
    };
    expect(body("../../../../engine/src/digest/schedule.ts")).toBe(body("./instant.ts"));
    expect(profileOf({ roles: '["trader","bogus"]', remote_mode: "remote,city", city: "  Kyiv ", salary_min: 5000, salary_currency: "EUR" })).toEqual({
      roles: ["trader"], remoteMode: "remote,city", city: "Kyiv", salaryMin: 5000, salaryCurrency: "EUR", roleText: null,
    });
    expect(profileOf({ roles: '["bd"]', remote_mode: "remote", city: null, salary_min: null, salary_currency: null, role_text: " Tokenomics " })).toMatchObject({
      roleText: "Tokenomics",
    });
    expect(profileOf({ roles: "not json", remote_mode: null, city: "   ", salary_min: null, salary_currency: null })).toMatchObject({
      roles: [], city: null,
    });
  });
});

describe("why it fits, and how many we checked", () => {
  it("the header numbers are the whole pool the matcher chose from, counted like the home page", async () => {
    const now = await instantMatches(deps(), brief({ roles: ["engineer"] }), new Set());
    expect(now.state).toBe("ok");
    if (now.state !== "ok") return;
    const crawl = (await crawlPool(jobs, NOW))!;
    const company = (await import("@/lib/crm/public-jobs")).loadCompanyJobs(ours.d1, {});
    const stats = homeStats(crawl, await company, NOW);
    expect(now.checked).toEqual({ jobs: stats.live, sources: stats.sources });
    // Живі скановані після сита (10 з 13 рядків: без давніх з дошки й ATS і без кухаря) плюс вакансія компанії.
    expect(now.checked.jobs).toBe(crawl.length + 1);
    expect(now.checked.jobs).toBe(11);
    // Джерела: greenhouse:chainlabs, ashby:lido, ashby:wintermute, board:de-web3 і вакансії компаній у нас.
    expect(now.checked.sources).toBe(5);
  });

  it("checkedIn counts sources once each, and company jobs as one source", () => {
    const j = (origin: string | null) => ({ origin }) as never;
    expect(checkedIn([j("greenhouse:a"), j("greenhouse:a"), j("board:web3career"), j(null)], [])).toEqual({ jobs: 4, sources: 2 });
    expect(checkedIn([j("greenhouse:a")], [j(null), j(null)])).toEqual({ jobs: 3, sources: 2 });
    expect(checkedIn([], [])).toEqual({ jobs: 0, sources: 0 });
  });

  it("reasons use the person's own words and score; the company sentence and logo come from the registry", async () => {
    nr.raw.exec(`INSERT INTO companies (slug, name, ats_provider, ats_slug, discovered_via, domain, about)
                 VALUES ('aave', 'Aave', 'greenhouse', 'aave', 'manual', 'aave.com', 'Aave runs lending markets on many chains.')`);
    const now = await instantMatches(deps(), brief({ roles: ["engineer"], salary_min: 120_000, salary_currency: "USD" }), new Set(),
      { words: "I want senior Solidity work", scores: { engineer: 81 } });
    expect(now.state).toBe("ok");
    if (now.state !== "ok") return;
    const aave = now.jobs.find((x) => x.ref === "nr:e1")!;
    expect(aave.reasons).toEqual([
      'Matches your Engineer role, and the title has your words "solidity".',
      "Pays $150k to $180k, meets your $120k minimum.",
      "A senior role, the level you asked for.",
    ]);
    expect(aave).toMatchObject({ about: "Aave runs lending markets on many chains.", domain: "aave.com", note: null });
    expect(aave.why).toBe(aave.reasons.join(" "));
    // Бал людини стає причиною, коли є місце (у вакансії без зарплати й рівня).
    const uni = now.jobs.find((x) => x.ref === "nr:e6")!;
    expect(uni.reasons).toContain("Your Engineer score is 81, from your public work.");
    // Вакансія компанії не бере чужий опис з реєстру.
    expect(now.jobs[0]).toMatchObject({ ref: "co:job_acme", about: null, domain: null });
  });
});

describe("the site pool", () => {
  it("reads the same rows as the engine, with the source and the board estimate of each", () => {
    expect(POOL_READ_SQL).toBe(POOL_SQL);
    for (const col of ["source", "salary_est_min", "salary_est_max", "salary_est_currency"]) expect(POOL_SQL).toContain(col);
  });
});

describe("counting honestly", () => {
  it("rounds down, never up", () => {
    expect([0, 7, 99, 100, 117, 120, 999, 1000, 1909, 2000, 12_345].map(roughCount)).toEqual([
      "0", "7", "99", "100", "110+", "120", "990+", "1,000", "1,900+", "2,000", "12,300+",
    ]);
  });
});
