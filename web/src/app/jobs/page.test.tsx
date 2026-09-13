import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomToken, sha256Hex } from "@/lib/auth/hash";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { readOnlyJobsDb, type JobsDb } from "@/lib/jobs-db";
import { resetNextrolePool } from "@/lib/jobs/nextrole-pool";
import { crmDb, run } from "@/test/crm-fixtures";
import { exec, harness, RedirectCalled, resetHarness } from "@/test/harness";
import { addPoolJob, nextroleJobsDb } from "@/test/nextrole-jobs-db";
import { migratedD1 } from "@/test/sqlite-d1";
import JobsPage from "./page";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/navigation", async () => (await import("@/test/harness")).navigationModule);

// База NextRole: прив'язку підміняємо на рівні модуля, як і в Worker лише через jobsDb().
const jobsHolder = vi.hoisted(() => ({ db: null as JobsDb | null }));
vi.mock("@/lib/jobs-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs-db")>()),
  jobsDb: () => jobsHolder.db,
}));

beforeEach(() => {
  resetHarness();
  resetNextrolePool();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const { raw, d1 } = crmDb();
  harness.raw = raw;
  harness.env.DB = d1;
  const nr = migratedD1([]);
  nr.raw.exec("CREATE TABLE jobs_cache (id TEXT PRIMARY KEY, url TEXT, company TEXT, title TEXT, location TEXT, remote INTEGER, salary_min INTEGER, salary_max INTEGER, salary_currency TEXT)");
  nr.raw.exec(`INSERT INTO jobs_cache VALUES
    ('mine', 'https://jobs.example.com/mine', 'Paying Labs', 'Protocol Engineer', 'Remote', 1, NULL, NULL, NULL),
    ('theirs', 'https://jobs.example.com/theirs', 'Other Labs', 'Secret Role', 'Remote', 1, NULL, NULL, NULL)`);
  jobsHolder.db = readOnlyJobsDb(nr.d1);
  exec("INSERT INTO users (id, email, roles, timezone) VALUES ('ada', 'ada@example.com', '[\"engineer\"]', 'Europe/Paris'), ('bob', 'bob@example.com', '[\"engineer\"]', NULL)");
});

async function signIn(userId: string): Promise<void> {
  const token = randomToken();
  exec("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))", await sha256Hex(token), userId);
  harness.jar.set(SESSION_COOKIE, token);
}

const render = async () => renderToStaticMarkup(await JobsPage());

describe("/jobs", () => {
  it("sends a visitor without a session to /login", async () => {
    const err = await JobsPage().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedirectCalled);
    expect((err as RedirectCalled).url).toBe("/login");
  });

  it("shows this person's jobs and never another person's", async () => {
    run(harness.raw, "INSERT INTO digest_runs (id, user_id, local_date, status, jobs, channel) VALUES ('dg_a', 'ada', '2026-09-12', 'sent', 1, 'email'), ('dg_b', 'bob', '2026-09-12', 'sent', 1, 'email')");
    run(harness.raw, `INSERT INTO sent (user_id, job_ref, source, digest_id, position, status, channel, why) VALUES
      ('ada', 'nr:mine', 'nextrole', 'dg_a', 1, 'sent', 'email', 'Matches your Engineer role. Remote.'),
      ('bob', 'nr:theirs', 'nextrole', 'dg_b', 1, 'sent', 'email', 'Matches your Engineer role. Remote.')`);
    await signIn("ada");
    const html = await render();
    expect(html).toContain("Sat, Sep 12");
    expect(html).toContain('href="https://jobs.example.com/mine"');
    expect(html).toContain("Protocol Engineer");
    expect(html).toContain("Matches your Engineer role. Remote.");
    expect(html).not.toContain("Secret Role");
    expect(html).not.toContain("Other Labs");
  });

  it("a company job links to its page on the site in the same tab, not to the company's address", async () => {
    run(harness.raw, "INSERT INTO companies (id, name, kind, status, terms_version, terms_accepted_at) VALUES ('co_x', 'Acme Labs', 'company', 'active', 'v1', datetime('now'))");
    run(
      harness.raw,
      `INSERT INTO company_jobs (id, company_id, status, title, apply_url, expires_at, created_via)
       VALUES ('job_live', 'co_x', 'open', 'Solidity Auditor', 'https://acme.io/jobs', datetime('now', '+30 days'), 'web')`,
    );
    run(harness.raw, "INSERT INTO digest_runs (id, user_id, local_date, status, jobs, channel) VALUES ('dg_a', 'ada', '2026-09-12', 'sent', 1, 'email')");
    run(harness.raw, "INSERT INTO sent (user_id, job_ref, source, digest_id, position, status, channel, why) VALUES ('ada', 'co:job_live', 'company', 'dg_a', 1, 'sent', 'email', 'Matches your Engineer role.')");
    await signIn("ada");
    const html = await render();
    expect(html).toMatch(/<a [^>]*href="\/jobs\/job_live"/);
    expect(html).not.toContain("acme.io/jobs");
    expect(html).not.toMatch(/href="\/jobs\/job_live"[^>]*target="_blank"/);
    expect(html).toContain("Posted by Acme Labs on NextCryptoJob");
  });

  it("says the jobs could not be loaded when our DB fails, instead of an error page", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await signIn("ada");
    const d1 = harness.env.DB;
    harness.env.DB = { prepare: d1.prepare.bind(d1), batch: async () => Promise.reject(new Error("D1_ERROR: overloaded")) } as unknown as D1Database;
    const html = await render();
    expect(html).toContain("We could not load your jobs right now.");
    expect(html).not.toContain("Your first jobs are coming.");
  });

  it("explains an empty page and links to settings", async () => {
    await signIn("bob");
    const html = await render();
    expect(html).toContain("Your first jobs are coming.");
    expect(html).toContain("every day at 07:00 (UTC), by email.");
    expect(html).toContain('href="/settings"');
  });
});

describe("/jobs: Jobs for you now", () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

  beforeEach(() => {
    const nr = nextroleJobsDb();
    const f = hoursAgo(2);
    addPoolJob(nr.raw, { id: "eng1", title: "Solidity Engineer", company: "Aave", postedAt: hoursAgo(5), fetchedAt: f });
    addPoolJob(nr.raw, { id: "eng2", title: "Rust Engineer", company: "Lido", postedAt: hoursAgo(9), fetchedAt: f, salaryMin: 120_000, salaryMax: 150_000, currency: "USD" });
    addPoolJob(nr.raw, { id: "trd1", title: "Crypto Trader", company: "Wintermute", postedAt: hoursAgo(3), fetchedAt: f });
    addPoolJob(nr.raw, { id: "lis1", title: "Backend Engineer", company: "Kiln", location: "Lisbon", remote: false, postedAt: hoursAgo(4), fetchedAt: f });
    jobsHolder.db = readOnlyJobsDb(nr.d1);
    exec("UPDATE users SET roles = '[\"trader\"]', remote_mode = 'remote' WHERE id = 'bob'");
    exec("UPDATE users SET remote_mode = 'remote' WHERE id = 'ada'");
  });

  it("shows live matches for the signed-in person's brief only, right away", async () => {
    await signIn("ada");
    const ada = await render();
    expect(ada).toContain("Jobs for you now");
    expect(ada).toContain("Solidity Engineer");
    expect(ada).toContain("Rust Engineer");
    expect(ada).toContain("Lido · Remote · $120k to $150k");
    expect(ada).toContain("Matches your Engineer role. Remote.");
    // Бобова роль і місто, яке ніхто не просив, у вибір Ади не йдуть.
    expect(ada).not.toContain("Crypto Trader");
    expect(ada).not.toContain("Backend Engineer");

    harness.jar.delete(SESSION_COOKIE);
    await signIn("bob");
    const bob = await render();
    expect(bob).toContain("Crypto Trader");
    expect(bob).not.toContain("Solidity Engineer");
  });

  it("leaves out what the digest already sent to this person, and only to this person", async () => {
    run(harness.raw, "INSERT INTO digest_runs (id, user_id, local_date, status, jobs, channel) VALUES ('dg_b', 'bob', '2026-09-12', 'sent', 1, 'email'), ('dg_a', 'ada', '2026-09-12', 'sent', 1, 'email')");
    run(harness.raw, `INSERT INTO sent (user_id, job_ref, source, digest_id, position, status, channel, why) VALUES
      ('bob', 'nr:eng1', 'nextrole', 'dg_b', 1, 'sent', 'email', 'x'),
      ('ada', 'nr:eng2', 'nextrole', 'dg_a', 1, 'failed', 'email', 'x')`);
    await signIn("ada");
    const html = await render();
    const now = html.slice(html.indexOf("Jobs for you now"), html.indexOf("Sent to you"));
    expect(now).toContain("Solidity Engineer");
    expect(now).not.toContain("Rust Engineer");
  });

  it("says why nothing matched and offers to edit the brief", async () => {
    exec("UPDATE users SET remote_mode = 'city', city = 'Berlin' WHERE id = 'ada'");
    await signIn("ada");
    const html = await render();
    expect(html).toContain("Nothing in Berlin right now.");
    expect(html).toContain("2 jobs for your roles are remote. Add remote work to see them.");
    expect(html).toContain('href="/welcome?step=place"');
  });

  it("asks for roles first when the brief has none", async () => {
    exec("UPDATE users SET roles = '[]' WHERE id = 'ada'");
    await signIn("ada");
    const html = await render();
    expect(html).toContain("Pick your roles first.");
    expect(html).not.toContain("Sent to you");
  });

  it("says live jobs are unavailable when the jobs database fails, and keeps the rest of the page", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    jobsHolder.db = { all: async () => Promise.reject(new Error("D1_ERROR: overloaded")), first: async () => null };
    await signIn("ada");
    const html = await render();
    expect(html).toContain("We could not load live jobs right now.");
    expect(html).toContain("Your first jobs are coming.");
  });

  it("offers the optional stand out steps after the brief, and not before or after them", async () => {
    exec("INSERT INTO consents (user_id, kind, granted, text_version) VALUES ('ada', 'scoring', 1, 'v1')");
    exec("UPDATE users SET onboarding_step = 'x' WHERE id = 'ada'");
    await signIn("ada");
    expect(await render()).toContain("Stand out to companies");
    exec("UPDATE users SET onboarding_step = 'done' WHERE id = 'ada'");
    expect(await render()).not.toContain("Stand out to companies");
  });
});
