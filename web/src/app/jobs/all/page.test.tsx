import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomToken, sha256Hex } from "@/lib/auth/hash";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { readOnlyJobsDb, type JobsDb } from "@/lib/jobs-db";
import { resetCompanyProfiles } from "@/lib/jobs/companies";
import { resetCrawlPool } from "@/lib/jobs/pool";
import { crmDb } from "@/test/crm-fixtures";
import { exec, harness, resetHarness } from "@/test/harness";
import { addPoolJob, jobsTestDb } from "@/test/jobs-db";
import AllJobsPage from "./page";

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
  const nr = jobsTestDb();
  const recent = new Date(Date.now() - 3_600_000).toISOString();
  addPoolJob(nr.raw, { id: "a1", title: "Solidity Engineer", company: "Aave", postedAt: recent, fetchedAt: recent });
  addPoolJob(nr.raw, { id: "a2", title: "Growth Marketer", company: "Aave", postedAt: recent, fetchedAt: recent });
  addPoolJob(nr.raw, { id: "l1", title: "Community Lead", company: "Lido", postedAt: recent, fetchedAt: recent });
  jobsHolder.db = readOnlyJobsDb(nr.d1);
  exec("INSERT INTO users (id, email, roles) VALUES ('ada', 'ada@example.com', '[\"engineer\"]')");
});

async function signIn(userId: string): Promise<void> {
  const token = randomToken();
  exec("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))", await sha256Hex(token), userId);
  harness.jar.set(SESSION_COOKIE, token);
}

const render = async (q: Record<string, string> = {}) =>
  renderToStaticMarkup(await AllJobsPage({ searchParams: Promise.resolve(q) })).replaceAll("&amp;", "&");

describe("/jobs/all", () => {
  it("shows every live job to a visitor, with no Save buttons and a way to start a profile", async () => {
    const html = await render();
    expect(html).toContain("<strong class=\"font-semibold\">3</strong> live jobs");
    for (const t of ["Solidity Engineer", "Growth Marketer", "Community Lead"]) expect(html).toContain(t);
    expect(html).not.toContain("aria-pressed");
    expect(html).toContain('href="/start"');
    expect(html).toContain('href="/jobs/all?company=aave"');
    expect(html).toContain("2 open roles");
  });

  it("filters by words and keeps the filter in the form", async () => {
    const html = await render({ q: "growth" });
    expect(html).toContain("Growth Marketer");
    expect(html).not.toContain("Community Lead");
    expect(html).toContain('value="growth"');
    expect(html).toContain("Clear filters");
  });

  it("lists one company's roles by its link", async () => {
    const html = await render({ company: "aave" });
    expect(html).toContain("live jobs at Aave");
    expect(html).not.toContain("Community Lead");
    expect(html).not.toContain("open roles");
  });

  it("gives a signed-in person Save buttons in their cabinet, with saved ones marked", async () => {
    exec("INSERT INTO saved_jobs (user_id, job_ref) VALUES ('ada', 'nr:l1')");
    await signIn("ada");
    const html = await render();
    expect(html).toContain('aria-label="Your account"');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(2);
  });
});
