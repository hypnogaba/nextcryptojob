import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readOnlyJobsDb, type JobsDb } from "@/lib/jobs-db";
import { crmDb } from "@/test/crm-fixtures";
import { addPoolJob, jobsTestDb } from "@/test/jobs-db";
import type { TestDb } from "@/test/sqlite-d1";
import { BROWSE_PAGE_SIZE, browseHref, browseInputOf, browseJobs, type BrowseInput } from "./browse";
import { resetCompanyProfiles } from "./companies";
import { resetCrawlPool } from "./pool";

const NOW = new Date("2026-09-13T12:00:00Z");
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

let nr: TestDb;
let ours: TestDb;
let reads: number;
let jobs: () => JobsDb;

beforeEach(() => {
  resetCrawlPool();
  resetCompanyProfiles();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  nr = jobsTestDb();
  const f = ago(2);
  addPoolJob(nr.raw, { id: "a1", title: "Senior Solidity Engineer", company: "Aave", postedAt: ago(24), fetchedAt: f });
  addPoolJob(nr.raw, { id: "a2", title: "Growth Marketer", company: "Aave", postedAt: ago(10), fetchedAt: f });
  addPoolJob(nr.raw, { id: "a3", title: "Protocol Engineer", company: "Aave", location: "Lisbon", remote: false, postedAt: ago(5), fetchedAt: f });
  addPoolJob(nr.raw, { id: "l1", title: "Community Lead", company: "Lido", postedAt: null, fetchedAt: f });
  ours = crmDb();
  reads = 0;
  const base = readOnlyJobsDb(nr.d1);
  jobs = () => ({ all: async <T,>(sql: string, ...p: unknown[]) => (reads++, base.all<T>(sql, ...p)), first: base.first });
});
afterEach(() => vi.restoreAllMocks());

const input = (o: Partial<BrowseInput> = {}): BrowseInput => ({ q: "", role: null, remote: false, company: null, page: 1, ...o });
const run = (o: Partial<BrowseInput> = {}) => browseJobs({ db: ours.d1, env: {}, jobs, now: NOW }, input(o));

describe("browseInputOf / browseHref", () => {
  it("reads filters from the address and drops bad values instead of failing", () => {
    expect(browseInputOf({ q: "  solidity ", role: "engineer", remote: "1", page: "3", company: "Aave" })).toEqual(
      input({ q: "solidity", role: "engineer", remote: true, page: 3, company: "aave" }),
    );
    expect(browseInputOf({ role: "wizard", page: "-2", remote: "yes" })).toEqual(input());
    expect(browseInputOf({ q: "x".repeat(300) }).q).toHaveLength(100);
  });

  it("builds the same address back, without empty filters", () => {
    expect(browseHref(input())).toBe("/jobs/all");
    expect(browseHref(input({ q: "rust dev", role: "engineer" }), { page: 2 })).toBe("/jobs/all?q=rust+dev&role=engineer&page=2");
  });
});

describe("browseJobs", () => {
  it("searches every live job, newest first, with the company's open role count", async () => {
    const r = await run();
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect(r.total).toBe(4);
    expect(r.jobs.map((j) => j.title)).toEqual(["Protocol Engineer", "Growth Marketer", "Senior Solidity Engineer", "Community Lead"]);
    expect(r.jobs[0]).toMatchObject({ ref: "nr:a3", company: "Aave", openRoles: 3, companyKey: "aave" });
    expect(r.jobs[3]!.openRoles).toBe(1);
    expect(r.jobs[0]!.freshness).toMatch(/^Posted Sep 13\. Still open on Sep 13\.$/);
  });

  it("filters by words, role, remote and company", async () => {
    const byWord = await run({ q: "solidity" });
    expect(byWord.state === "ok" && byWord.jobs.map((j) => j.ref)).toEqual(["nr:a1"]);
    const byRole = await run({ role: "engineer", remote: true });
    expect(byRole.state === "ok" && byRole.jobs.map((j) => j.ref)).toEqual(["nr:a1"]);
    const byCompany = await run({ company: "aave" });
    expect(byCompany.state === "ok" && byCompany.total).toBe(3);
    expect(byCompany.state === "ok" && byCompany.companyName).toBe("Aave");
  });

  it("pages by BROWSE_PAGE_SIZE and keeps a page past the end on the last page", async () => {
    for (let i = 0; i < BROWSE_PAGE_SIZE + 5; i++) {
      addPoolJob(nr.raw, { id: `x${i}`, title: `Engineer ${i}`, company: `Co ${i}`, postedAt: ago(100 + i), fetchedAt: ago(2) });
    }
    const last = await run({ page: 9 });
    expect(last.state === "ok" && [last.page, last.pages, last.jobs.length]).toEqual([2, 2, 29 - BROWSE_PAGE_SIZE]);
  });

  it("reads the jobs database once and serves the next searches from memory", async () => {
    await run();
    const after = reads;
    await run({ q: "lead" });
    expect(reads).toBe(after);
  });

  it("says live jobs are unavailable when the jobs database fails", async () => {
    jobs = () => ({ all: async () => { throw new Error("D1_ERROR"); }, first: async () => null }) as unknown as JobsDb;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await run()).toEqual({ state: "unavailable" });
  });
});
