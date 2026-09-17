import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomToken, sha256Hex } from "@/lib/auth/hash";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { readOnlyJobsDb, type JobsDb } from "@/lib/jobs-db";
import { resetCompanyProfiles } from "@/lib/jobs/companies";
import { resetCrawlPool } from "@/lib/jobs/pool";
import { crmDb } from "@/test/crm-fixtures";
import { exec, harness, resetHarness } from "@/test/harness";
import { migratedD1 } from "@/test/sqlite-d1";
import SavedJobsPage from "./page";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/navigation", async () => (await import("@/test/harness")).navigationModule);

const jobsHolder = vi.hoisted(() => ({ db: null as JobsDb | null }));
vi.mock("@/lib/jobs-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs-db")>()),
  jobsDb: () => jobsHolder.db,
}));

beforeEach(() => {
  resetHarness();
  resetCrawlPool();
  resetCompanyProfiles();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const { raw, d1 } = crmDb();
  harness.raw = raw;
  harness.env.DB = d1;
  const nr = migratedD1([]);
  nr.raw.exec(
    "CREATE TABLE jobs_cache (id TEXT PRIMARY KEY, url TEXT, company TEXT, title TEXT, location TEXT, remote INTEGER, salary_min INTEGER, salary_max INTEGER, salary_currency TEXT, salary_est_min INTEGER, salary_est_max INTEGER, salary_est_currency TEXT, source TEXT, posted_at TEXT, first_seen_at TEXT, fetched_at TEXT)",
  );
  nr.raw.exec(`INSERT INTO jobs_cache (id, url, company, title, location, remote, posted_at, first_seen_at, fetched_at) VALUES
    ('mine', 'https://jobs.example.com/mine', 'Paying Labs', 'Protocol Engineer', 'Remote', 1, '2026-09-03T10:00:00.000Z', '2026-09-04T04:30:00.000Z', '2026-09-16T04:40:00.000Z'),
    ('theirs', 'https://jobs.example.com/theirs', 'Other Labs', 'Secret Role', 'Remote', 1, NULL, NULL, NULL)`);
  jobsHolder.db = readOnlyJobsDb(nr.d1);
  exec(
    "INSERT INTO users (id, email, roles, timezone) VALUES ('ada', 'ada@example.com', '[\"engineer\"]', 'Europe/Paris'), ('bob', 'bob@example.com', '[\"engineer\"]', NULL)",
  );
});

async function signIn(userId: string): Promise<void> {
  const token = randomToken();
  exec("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))", await sha256Hex(token), userId);
  harness.jar.set(SESSION_COOKIE, token);
}

const render = async () => renderToStaticMarkup(await SavedJobsPage());

/**
 * Власник 17.09: «вакансії потрібно якось розділити, збережені кудись окремо, підпунктом, щоб
 * там було видно всі збережені». Сторінка бере той самий список, що раніше стояв третім блоком
 * на /jobs, і лише свої збереження людини з сесії.
 */
describe("/jobs/saved", () => {
  it("lists this person's saved jobs, including one that is no longer listed", async () => {
    harness.raw.exec(`INSERT INTO saved_jobs (user_id, job_ref, created_at) VALUES
      ('ada', 'nr:mine', '2026-09-16 10:00:00'), ('ada', 'nr:gone', '2026-09-15 10:00:00'), ('bob', 'nr:theirs', '2026-09-16 10:00:00')`);
    await signIn("ada");
    const html = await render();
    expect(html).toContain("Saved jobs");
    expect(html).toContain("2 jobs");
    expect(html).toContain("Protocol Engineer");
    expect(html).toContain("Posted Sep 3. Still open on Sep 16.");
    expect(html).toContain("This job is no longer listed.");
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(2);
    // Чужого збереження не видно ніде.
    expect(html).not.toContain("Secret Role");
  });

  it("says plainly that nothing is saved yet, and sends the person back to their jobs", async () => {
    await signIn("ada");
    const html = await render();
    expect(html).toContain("You have not saved a job yet.");
    expect(html).toContain('href="/jobs"');
    expect(html).not.toContain("Protocol Engineer");
  });

  it("keeps the saved page active in the cabinet menu", async () => {
    await signIn("ada");
    const html = await render();
    expect(html).toMatch(/aria-current="page"[^>]*href="\/jobs\/saved"/);
  });
});
