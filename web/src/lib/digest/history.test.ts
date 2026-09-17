import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readOnlyJobsDb, type JobsDb } from "@/lib/jobs-db";
import { addCompany, crmDb, run } from "@/test/crm-fixtures";
import { jobsTestDb } from "@/test/jobs-db";
import { type TestDb } from "@/test/sqlite-d1";
import { resetCompanyProfiles } from "@/lib/jobs/companies";
import { HISTORY_DAYS, HISTORY_LIMIT, loadJobsPage } from "./history";

let t: TestDb;
let nr: TestDb;
let jobs: JobsDb;
let jobsCalls: unknown[][];

/** База вакансій у тесті: справжня схема db/jobs. */
const jobsDbForTest = (): TestDb => jobsTestDb();

function spyJobs(inner: JobsDb): JobsDb {
  return {
    all: async (sql, ...params) => {
      // Лише запити до вакансій: реєстр компаній (значки й «про компанію») читається без параметрів людини.
      if (/FROM jobs_cache/.test(sql)) jobsCalls.push(params);
      return inner.all(sql, ...params);
    },
    first: inner.first,
  };
}

function nrJob(id: string, o: { title?: string; company?: string; location?: string | null; remote?: number; url?: string; min?: number | null; max?: number | null; cur?: string | null } = {}) {
  run(
    nr.raw,
    `INSERT INTO jobs_cache (id, url, company, company_key, title, location, remote, salary_min, salary_max, salary_currency,
                             source, dedupe_key, fetched_at, first_seen_at)
     VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, 'greenhouse:x', '', '2026-09-12T00:00:00Z', '2026-09-12T00:00:00Z')`,
    id,
    o.url ?? `https://jobs.example.com/${id}`,
    o.company ?? `Company ${id}`,
    o.title ?? `Job ${id}`,
    o.location === undefined ? "Remote" : o.location,
    o.remote ?? 1,
    o.min ?? null,
    o.max ?? null,
    o.cur ?? null,
  );
}

function user(raw: DatabaseSync, id: string, o: { email?: string | null; telegram?: string | null; channel?: string; paused?: number; roles?: string; hour?: number; tz?: string | null } = {}) {
  run(
    raw,
    "INSERT INTO users (id, email, telegram_id, channel, digest_paused, roles, digest_hour, timezone) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    o.email === undefined ? `${id}@example.com` : o.email,
    o.telegram ?? null,
    o.channel ?? "email",
    o.paused ?? 0,
    o.roles ?? '["engineer"]',
    o.hour ?? 7,
    o.tz === undefined ? "Europe/Paris" : o.tz,
  );
}

/** Прогін добірки з рядками sent; created_at задає вік (для вікна 14 днів). */
function digest(userId: string, id: string, localDate: string, refs: string[], o: { status?: string; channel?: string; age?: string; runStatus?: string } = {}) {
  run(
    t.raw,
    "INSERT INTO digest_runs (id, user_id, local_date, status, jobs, channel) VALUES (?, ?, ?, ?, ?, ?)",
    id,
    userId,
    localDate,
    o.runStatus ?? "sent",
    refs.length,
    o.channel ?? "email",
  );
  refs.forEach((ref, i) =>
    run(
      t.raw,
      `INSERT INTO sent (user_id, job_ref, source, digest_id, position, status, channel, why, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`,
      userId,
      ref,
      ref.startsWith("co:") ? "company" : "nextrole",
      id,
      i + 1,
      o.status ?? "sent",
      o.channel ?? "email",
      `Why ${ref}`,
      o.age ?? "-1 hours",
    ),
  );
}

const refsOf = (page: Awaited<ReturnType<typeof loadJobsPage>>) => page!.digests.map((d) => [d.localDate, d.jobs.map((j) => j.ref)]);

beforeEach(() => {
  resetCompanyProfiles();
  t = crmDb();
  nr = jobsDbForTest();
  jobsCalls = [];
  jobs = spyJobs(readOnlyJobsDb(nr.d1));
  user(t.raw, "ada");
  user(t.raw, "bob");
});

afterEach(() => vi.restoreAllMocks());

describe("loadJobsPage: tenant isolation", () => {
  it("returns only this person's sent rows and asks the jobs DB only for their jobs", async () => {
    for (const id of ["a1", "a2", "b1", "b2"]) nrJob(id);
    digest("ada", "dg_a", "2026-09-12", ["nr:a1", "nr:a2"]);
    digest("bob", "dg_b", "2026-09-12", ["nr:b1", "nr:b2"]);

    const page = await loadJobsPage(t.d1, jobs, "ada");
    expect(refsOf(page)).toEqual([["2026-09-12", ["nr:a1", "nr:a2"]]]);
    expect(jobsCalls).toEqual([["a1", "a2"]]);
    expect(refsOf(await loadJobsPage(t.d1, jobs, "bob"))).toEqual([["2026-09-12", ["nr:b1", "nr:b2"]]]);
  });

  it("ignores a sent row that points at another person's digest, for both people", async () => {
    nrJob("a1");
    nrJob("x");
    digest("ada", "dg_a", "2026-09-12", ["nr:a1"]);
    // Зіпсований рядок: людина bob, а добірка ada. Ні в кого не показуємо.
    run(t.raw, "INSERT INTO sent (user_id, job_ref, source, digest_id, position, status, channel) VALUES ('bob', 'nr:x', 'nextrole', 'dg_a', 2, 'sent', 'email')");

    expect(refsOf(await loadJobsPage(t.d1, jobs, "ada"))).toEqual([["2026-09-12", ["nr:a1"]]]);
    expect((await loadJobsPage(t.d1, jobs, "bob"))!.digests).toEqual([]);
  });

  it("gives null for a user that is gone", async () => {
    expect(await loadJobsPage(t.d1, jobs, "nobody")).toBeNull();
  });
});

describe("loadJobsPage: what it shows", () => {
  it("groups by digest, newest date first, jobs in position order", async () => {
    for (const id of ["1", "2", "3", "4"]) nrJob(id);
    digest("ada", "dg_old", "2026-09-10", ["nr:1", "nr:2"], { channel: "telegram", age: "-2 days" });
    digest("ada", "dg_new", "2026-09-12", ["nr:3", "nr:4"]);

    const page = await loadJobsPage(t.d1, jobs, "ada");
    expect(page!.digests.map((d) => [d.localDate, d.channel, d.jobs.map((j) => j.ref)])).toEqual([
      ["2026-09-12", "email", ["nr:3", "nr:4"]],
      ["2026-09-10", "telegram", ["nr:1", "nr:2"]],
    ]);
    // Один запит до бази вакансій на всі добірки.
    expect(jobsCalls).toHaveLength(1);
  });

  it(`shows only delivered rows from the last ${HISTORY_DAYS} days`, async () => {
    for (const id of ["ok", "failed", "pending", "old"]) nrJob(id);
    digest("ada", "dg_ok", "2026-09-12", ["nr:ok"]);
    digest("ada", "dg_failed", "2026-09-11", ["nr:failed"], { status: "failed", runStatus: "failed" });
    digest("ada", "dg_pending", "2026-09-10", ["nr:pending"], { status: "pending", runStatus: "pending" });
    digest("ada", "dg_old", "2026-08-01", ["nr:old"], { age: `-${HISTORY_DAYS + 1} days` });

    expect(refsOf(await loadJobsPage(t.d1, jobs, "ada"))).toEqual([["2026-09-12", ["nr:ok"]]]);
  });

  it(`reads at most ${HISTORY_LIMIT} refs, with one query per source`, async () => {
    for (let day = 0; day < 20; day++) {
      const refs = [1, 2, 3, 4, 5].map((i) => `nr:d${day}j${i}`);
      digest("ada", `dg_${day}`, `2026-08-${String(day + 10).padStart(2, "0")}`, refs, { age: `-${day} hours` });
    }
    const page = await loadJobsPage(t.d1, jobs, "ada");
    expect(page!.digests.flatMap((d) => d.jobs)).toHaveLength(HISTORY_LIMIT);
    expect(jobsCalls).toHaveLength(1);
    expect(jobsCalls[0]).toHaveLength(HISTORY_LIMIT);
  });

  it("fills details from scanned and company jobs, and says which are gone", async () => {
    nrJob("1", { title: "Protocol  Engineer", company: "Paying Labs", location: null, remote: 1, min: 120000, max: 150000, cur: "USD" });
    nrJob("2", { url: "javascript:alert(1)" });
    const co = addCompany(t.raw, { name: "Acme Labs" });
    run(
      t.raw,
      `INSERT INTO company_jobs (id, company_id, status, title, remote_mode, city, salary_min, salary_max, salary_currency, salary_period,
                                apply_url, expires_at, created_via)
       VALUES ('job_live', ?, 'open', 'Solidity Auditor', 'remote,city', 'Lisbon', 8000, 10000, 'EUR', 'month',
               'https://acme.io/jobs', datetime('now', '+30 days'), 'web'),
              ('job_hidden', ?, 'closed', 'Hidden', 'remote', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'web')`,
      co,
      co,
    );
    run(t.raw, "UPDATE company_jobs SET hidden_by_admin_at = datetime('now') WHERE id = 'job_hidden'");
    digest("ada", "dg_a", "2026-09-12", ["nr:1", "nr:2", "co:job_live", "co:job_hidden", "nr:gone"]);

    const [d] = (await loadJobsPage(t.d1, jobs, "ada"))!.digests;
    // Рядок актуальності перевіряємо окремо: у ньому сьогоднішня дата.
    const freshness = d.jobs.map((j) => j.details?.freshness);
    const details = (j: (typeof d.jobs)[number]) => {
      if (!j.details) return null;
      const { freshness: _f, ...rest } = j.details;
      return rest;
    };
    expect(freshness[2]).toMatch(/^Still open on [A-Z][a-z]{2} \d{1,2}\.$/);
    expect(d.jobs.map((j) => [j.ref, j.state, details(j)])).toEqual([
      ["nr:1", "ok", { title: "Protocol Engineer", company: "Paying Labs", location: "Remote", salary: "$120k to $150k", url: "https://jobs.example.com/1", postedBy: null }],
      ["nr:2", "ok", { title: "Job 2", company: "Company 2", location: "Remote", salary: null, url: null, postedBy: null }],
      // Вакансія компанії веде на свою сторінку на сайті, не прямо на apply_url.
      ["co:job_live", "ok", { title: "Solidity Auditor", company: "Acme Labs", location: "Remote or Lisbon", salary: "€8k to €10k a month", url: "/jobs/job_live", postedBy: "Acme Labs" }],
      ["co:job_hidden", "gone", null],
      ["nr:gone", "gone", null],
    ]);
    expect(d.jobs[0].why).toBe("Why nr:1");
  });

  it("keeps the page when the jobs DB fails, marking its jobs unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing: JobsDb = { all: async () => Promise.reject(new Error("D1_ERROR: 429")), first: async () => null };
    digest("ada", "dg_a", "2026-09-12", ["nr:1"]);
    const [d] = (await loadJobsPage(t.d1, failing, "ada"))!.digests;
    expect(d.jobs.map((j) => j.state)).toEqual(["unavailable"]);
  });

  it("does not touch the jobs DB when there is nothing from it", async () => {
    await loadJobsPage(t.d1, jobs, "ada");
    expect(jobsCalls).toEqual([]);
  });

  it("says the history could not be read when our DB fails on it, instead of crashing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    digest("ada", "dg_a", "2026-09-12", ["nr:1"]);
    const broken = { ...t.d1, prepare: t.d1.prepare, batch: async () => Promise.reject(new Error("D1_ERROR: overloaded")) } as unknown as D1Database;
    const page = await loadJobsPage(broken, jobs, "ada");
    expect(page).toMatchObject({ digests: [], historyError: true, setup: { channel: "email", hour: 7 } });
  });

  it("marks company jobs unavailable when their read fails, and keeps the rest", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    nrJob("1");
    digest("ada", "dg_a", "2026-09-12", ["co:job_x", "nr:1"]);
    const d1 = t.d1;
    const flaky = {
      prepare: (sql: string) => {
        if (sql.includes("FROM company_jobs")) throw new Error("D1_ERROR: overloaded");
        return d1.prepare(sql);
      },
      batch: d1.batch.bind(d1),
    } as unknown as D1Database;
    const page = await loadJobsPage(flaky, jobs, "ada");
    expect(page!.historyError).toBe(false);
    expect(page!.digests[0].jobs.map((j) => [j.ref, j.state])).toEqual([["co:job_x", "unavailable"], ["nr:1", "ok"]]);
  });
});

describe("loadJobsPage: setup for the empty state", () => {
  it("picks the channel the engine would use and reads pause, roles, hour and the last run", async () => {
    user(t.raw, "tg", { email: null, telegram: "555", channel: "email", paused: 1, roles: "[]", hour: 9, tz: null });
    digest("tg", "dg_tg", "2026-09-11", [], { runStatus: "empty" });
    expect((await loadJobsPage(t.d1, jobs, "tg"))!.setup).toEqual({
      paused: true,
      channel: "telegram",
      hasRoles: false,
      hour: 9,
      timezone: "UTC",
      lastRun: "empty",
    });

    user(t.raw, "none", { email: null, telegram: null });
    expect((await loadJobsPage(t.d1, jobs, "none"))!.setup.channel).toBeNull();
    // Telegram як канал, але без прив'язки: engine шле поштою.
    user(t.raw, "mixed", { channel: "telegram", telegram: null });
    expect((await loadJobsPage(t.d1, jobs, "mixed"))!.setup.channel).toBe("email");
  });
});
