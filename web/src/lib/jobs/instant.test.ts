import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as engineJobs from "../../../../engine/src/digest/jobs";
import * as engineMatch from "../../../../engine/src/digest/match";
import { readFileSync } from "node:fs";
import { readOnlyJobsDb, type JobsDb } from "@/lib/jobs-db";
import { addCompany, addSubscription, crmDb, run } from "@/test/crm-fixtures";
import { addPoolJob, jobsTestDb } from "@/test/jobs-db";
import type { TestDb } from "@/test/sqlite-d1";
import {
  type BriefRow,
  instantMatches,
  profileOf,
  roughCount,
} from "./instant";
import { POOL_SQL, POOL_READ_SQL, resetCrawlPool } from "./pool";

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

/** Живий пул з тими пастками, які добірка обходить: одна компанія двічі, «Hybrid», нац. дошка, старе, не наша роль. */
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

/** Що вибрала б добірка engine: її власний пул з тих самих рядків і її selectJobs. */
function engineChoice(b: BriefRow, exclude: Set<string>) {
  const live = new Date(NOW.getTime() - engineJobs.LIVE_WINDOW_DAYS * 86_400_000).toISOString();
  const posted = new Date(NOW.getTime() - engineJobs.POSTED_WINDOW_DAYS * 86_400_000).toISOString();
  const rows = nr.raw.prepare(engineJobs.POOL_SQL).all(live, posted) as never[];
  const crawl = rows.flatMap((r) => {
    const x = engineJobs.crawlJob(r);
    return "job" in x ? [x.job] : [];
  });
  const company = (ours.raw.prepare("SELECT * FROM company_jobs_live").all() as never[])
    .map((r) => engineJobs.companyJob(r, "https://nextcryptojob.xyz"))
    .filter((j) => j !== null);
  return engineMatch
    .selectJobs({ crawl, company }, profileOf(b), { now: NOW, exclude })
    .map((p) => ({ ref: p.job.ref, why: p.why }));
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
    // рахується, коли скан бачив: e6 2 год тому); Aave лише раз, і не надіслана e2. «Hybrid» (e4)
    // і національна дошка (e5) не віддалені, Lisbon (e3) не для віддаленої анкети.
    expect(refs).toEqual(["co:job_acme", "nr:e6", "nr:e1"]);
    expect(now.jobs[0]).toMatchObject({ url: "/jobs/job_acme", postedBy: "Acme Labs", location: "Remote or Lisbon" });
    expect(now.jobs[2]).toMatchObject({ company: "Aave", salary: "$150k to $180k", url: "https://boards.example.com/e1" });
    expect(now.jobs.every((j) => j.why.startsWith("Matches your Engineer role."))).toBe(true);
  });

  it("the preferences decide: a city brief sees the city job, a remote brief does not", async () => {
    const city = await instantMatches(deps(), brief({ roles: ["designer"], remote_mode: "city", city: "lisboa" }), new Set());
    expect(city).toMatchObject({ state: "ok", jobs: [{ ref: "nr:d1", why: "Matches your Designer role. In lisboa." }] });
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
      remote: 4,
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
