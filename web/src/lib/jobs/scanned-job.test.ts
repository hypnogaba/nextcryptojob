import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { readOnlyJobsDb } from "@/lib/jobs-db";
import { jobsTestDb } from "@/test/jobs-db";
import { EMPTY_PROFILES } from "./companies";
import { isScannedJobId, loadScannedJob } from "./scanned-job";

let raw: DatabaseSync;
let jobs: ReturnType<typeof readOnlyJobsDb>;

function insertJob(fields: Partial<{ id: string; postedAt: string | null; firstSeenAt: string; source: string; remote: number }> = {}) {
  const f = {
    id: "j" + "a".repeat(24),
    postedAt: null as string | null,
    firstSeenAt: new Date().toISOString(),
    source: "board:example",
    remote: 1,
    ...fields,
  };
  raw
    .prepare(
      `INSERT INTO jobs_cache (id, url, company, company_key, title, location, remote, salary_min, salary_max, salary_currency,
                               source, tags, dedupe_key, posted_at, fetched_at, first_seen_at, country)
       VALUES (?, 'https://jobs.example.com/x', 'Acme', 'acme', 'Protocol Engineer', 'Remote', ?, 90000, 150000, 'USD',
               ?, '["web3"]', 'acme-protocol-engineer', ?, datetime('now'), ?, NULL)`,
    )
    .run(f.id, f.remote, f.source, f.postedAt, f.firstSeenAt);
}

beforeEach(() => {
  const t = jobsTestDb();
  raw = t.raw;
  jobs = readOnlyJobsDb(t.d1);
});

describe("isScannedJobId", () => {
  it.each(["j" + "a".repeat(24), "j" + "0123456789abcdef01234567"])("accepts %j", (id) => expect(isScannedJobId(id)).toBe(true));
  it.each(["job_aBcDeFgHiJkLmNoPqRsT", "j123", "", "' OR 1=1 --"])("rejects %j", (id) => expect(isScannedJobId(id)).toBe(false));
});

describe("loadScannedJob (item 20)", () => {
  it("loads title, company, location, salary and roles from jobs_cache", async () => {
    insertJob();
    const job = await loadScannedJob(jobs, "j" + "a".repeat(24), EMPTY_PROFILES);
    expect(job).toMatchObject({
      title: "Protocol Engineer",
      company: "Acme",
      location: "Remote",
      salary: "$90k to $150k",
    });
    expect(job?.roleNames.length).toBeGreaterThan(0);
  });

  it("is null for an id that does not exist", async () => {
    expect(await loadScannedJob(jobs, "j" + "a".repeat(24), EMPTY_PROFILES)).toBeNull();
  });

  it("is null for a malformed or CRM-shaped id", async () => {
    insertJob();
    expect(await loadScannedJob(jobs, "job_aBcDeFgHiJkLmNoPqRs", EMPTY_PROFILES)).toBeNull();
  });

  it("is null once the posting is older than the live window (closed)", async () => {
    insertJob({ postedAt: new Date(Date.now() - 40 * 86_400_000).toISOString() });
    expect(await loadScannedJob(jobs, "j" + "a".repeat(24), EMPTY_PROFILES)).toBeNull();
  });

  it("stays live longer for a company's own ATS feed", async () => {
    insertJob({ source: "greenhouse:acme", postedAt: new Date(Date.now() - 40 * 86_400_000).toISOString() });
    const job = await loadScannedJob(jobs, "j" + "a".repeat(24), EMPTY_PROFILES);
    expect(job).not.toBeNull();
  });
});
