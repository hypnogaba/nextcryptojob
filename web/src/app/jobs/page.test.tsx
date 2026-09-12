import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomToken, sha256Hex } from "@/lib/auth/hash";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { readOnlyJobsDb, type JobsDb } from "@/lib/jobs-db";
import { crmDb, run } from "@/test/crm-fixtures";
import { exec, harness, RedirectCalled, resetHarness } from "@/test/harness";
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

  it("explains an empty page and links to settings", async () => {
    await signIn("bob");
    const html = await render();
    expect(html).toContain("Your first jobs are coming.");
    expect(html).toContain("every day at 07:00 (UTC), by email.");
    expect(html).toContain('href="/settings"');
  });
});
