import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetJobSourcesCache } from "@/lib/admin/job-sources";
import { resetSettingsCache } from "@/lib/admin/settings";
import { createSession } from "@/lib/auth/session";
import { OVERVIEW_NOW, seedOverview } from "@/test/admin-fixtures";
import { exec, harness, resetHarness } from "@/test/harness";
import { addCachedJob, addScanRun, jobsTestDb } from "@/test/jobs-db";
import AdminHealthPage from "./page";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);

class NotFoundCalled extends Error {}
vi.mock("next/navigation", async () => ({
  ...(await import("@/test/harness")).navigationModule,
  notFound: (): never => {
    throw new NotFoundCalled("notFound()");
  },
}));

// База вакансій: справжній SQLite, як на /admin/sources.
const jobs = vi.hoisted(() => ({ d1: null as unknown as D1Database, reads: 0 }));
vi.mock("@/lib/jobs-db", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/jobs-db")>();
  return {
    ...mod,
    jobsDb: () => {
      const db = mod.readOnlyJobsDb(jobs.d1);
      return { ...db, all: (sql: string, ...params: unknown[]) => (jobs.reads++, db.all(sql, ...params)) };
    },
  };
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(OVERVIEW_NOW);
  resetJobSourcesCache();
  resetSettingsCache();
  resetHarness({ ADMIN_EMAILS: "boss@example.com" } as never);
  exec("INSERT INTO users (id, email, telegram_id, created_at) VALUES ('boss', 'boss@example.com', '555', '2026-06-01 00:00:00')");
  const t = jobsTestDb();
  addCachedJob(t.raw, { source: "greenhouse:coinbase", company: "Coinbase", fetchedAt: "2026-09-13T04:40:00.000Z" });
  addScanRun(t.raw, { id: "s1", startedAt: "2026-09-13T04:30:00.000Z" });
  jobs.d1 = t.d1;
  jobs.reads = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

async function render(query: Record<string, string> = {}): Promise<string> {
  return renderToStaticMarkup(await AdminHealthPage({ searchParams: Promise.resolve(query) })).replaceAll("&#x27;", "'");
}

describe("/admin/health", () => {
  beforeEach(async () => {
    seedOverview(harness.raw);
    await createSession("boss", "email");
  });

  it("is not found for someone who is not an admin", async () => {
    resetHarness({ ADMIN_EMAILS: "someone-else@example.com" } as never);
    exec("INSERT INTO users (id, email, created_at) VALUES ('boss', 'boss@example.com', '2026-06-01 00:00:00')");
    await createSession("boss", "email");
    await expect(render()).rejects.toBeInstanceOf(NotFoundCalled);
  });

  it("holds everything the overview used to hide: engines, cron, digests, alerts and demo", async () => {
    exec(`INSERT INTO owner_alerts (key, kind, sent_at, summary, channel) VALUES
      ('agency:app_1', 'agency', '2026-09-13 10:00:00', 'New agency application: Hire3', 'telegram')`);
    const html = await render();
    for (const title of ["Health", "Scores", "Daily digests", "Alerts to you", "Demo company"]) {
      expect(html).toContain(`>${title}</h2>`);
    }
    // Добірки сьогодні: 3 прогони, 1 надіслано, 1 впала.
    expect(html).toMatch(/data-day="2026-09-13".*?>3<\/td><td[^>]*>1<\/td><td[^>]*>1<\/td>/);
    expect(html).toContain("Telegram 403: bot was blocked by the user");
    expect(html).toContain("hidden from companies: no passed quality run");
    expect(html).toMatch(/<tr[^>]*data-job="cleanup.daily"[^>]*data-late=""/);
    expect(html).toContain("New agency application: Hire3");
    expect(html).toContain("Send this week's report now");
    expect(html).toContain("Create demo company");
  });

  it("says how the weekly report went, straight from the address", async () => {
    const html = await render({ done: "weekly", ch: "telegram,email" });
    expect(html).toContain("Report sent by telegram and email.");
  });
});
