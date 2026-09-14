import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_PAGES } from "@/components/admin-nav";
import { resetJobSourcesCache } from "@/lib/admin/job-sources";
import { OVERVIEW_STATEMENTS } from "@/lib/admin/overview";
import { resetSettingsCache } from "@/lib/admin/settings";
import { createSession } from "@/lib/auth/session";
import { OVERVIEW_NOW, seedOverview } from "@/test/admin-fixtures";
import { exec, harness, resetHarness } from "@/test/harness";
import { addCachedJob, addScanRun, jobsTestDb } from "@/test/jobs-db";
import { migratedD1 } from "@/test/sqlite-d1";
import AdminOverviewPage from "./page";

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

/** Лічильник звернень до основної бази: скільки інструкцій і пакетів за один показ. */
let calls: { prepared: string[]; batches: number[] };

function countCalls(): void {
  const d1 = harness.env.DB;
  calls = { prepared: [], batches: [] };
  harness.env.DB = {
    ...d1,
    prepare: (sql: string) => (calls.prepared.push(sql), d1.prepare(sql)),
    batch: (s: D1PreparedStatement[]) => (calls.batches.push(s.length), d1.batch(s)),
  } as D1Database;
}

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

async function render(): Promise<string> {
  return renderToStaticMarkup(await AdminOverviewPage()).replaceAll("&#x27;", "'");
}

describe("/admin access", () => {
  it("is not found for someone who is not an admin, and reads no numbers", async () => {
    exec("INSERT INTO users (id, email) VALUES ('ada', 'ada@example.com')");
    await createSession("ada", "email");
    countCalls();
    await expect(render()).rejects.toBeInstanceOf(NotFoundCalled);
    expect(calls.batches).toEqual([]);
    expect(jobs.reads).toBe(0);
  });

  it("is not found for an admin who signed in through Telegram", async () => {
    await createSession("boss", "telegram");
    countCalls();
    await expect(render()).rejects.toBeInstanceOf(NotFoundCalled);
    expect(calls.batches).toEqual([]);
  });

  it("is not found without a session", async () => {
    await expect(render()).rejects.toBeInstanceOf(NotFoundCalled);
  });
});

describe("/admin for an admin", () => {
  beforeEach(async () => {
    seedOverview(harness.raw);
    await createSession("boss", "email");
  });

  it("is the first item of the admin menu", () => {
    expect(ADMIN_PAGES[0]).toEqual({ href: "/admin", label: "Overview" });
    expect(ADMIN_PAGES.map((p) => p.href)).toContain("/admin/settings");
  });

  it("shows every block with counts from the database and links to the detail pages", async () => {
    const html = await render();
    expect(html).toContain('aria-current="page"');
    for (const title of ["Candidates", "Scores", "Daily digests", "Companies", "Payments", "Jobs", "Health"]) {
      expect(html).toContain(`>${title}</h2>`);
    }
    // Воронка: 5 людей (4 з даних і адмін), 3 почали анкету.
    expect(html).toMatch(/Brief started<\/th><td[^>]*>3<\/td>/);
    expect(html).toMatch(/Signed up<\/th><td[^>]*>5<\/td>/);
    // Добірки сьогодні: 3 прогони, 1 надіслано, 1 впала.
    expect(html).toMatch(/data-day="2026-09-13".*?>3<\/td><td[^>]*>1<\/td><td[^>]*>1<\/td>/);
    expect(html).toContain("Telegram 403: bot was blocked by the user");
    expect(html).toContain("hidden from companies: no passed quality run");
    for (const href of ["/admin/companies", "/admin/agency-applications", "/admin/jobs", "/admin/payments", "/admin/sources", "/admin/settings", "/admin/x-queue"]) {
      expect(html).toContain(`href="${href}"`);
    }
    // Вакансії зі звіту джерел.
    expect(html).toMatch(/Live web3 jobs<\/dt><dd[^>]*>2<\/dd>/);
    expect(html).toContain("The job scanner runs every day at 04:30 UTC, weekends included");
    // Неділя, сьогоднішній скан на місці (сканер ходить і у вихідні): прапорця немає.
    expect(html).not.toContain("Job scanner missed");
    expect(html).not.toContain("NextRole");
    expect(jobs.reads).toBe(1);
  });

  it("lists what needs attention: late and failed cron jobs, stuck digests, payments waiting for a refund", async () => {
    const html = await render();
    expect(html).toContain("Cron x402.stale (0 * * * *): no run recorded yet.");
    expect(html).toContain("Cron cleanup.daily (0 3 * * *) is late: last run 33 h ago.");
    expect(html).toContain("Cron webhooks.deliver: the last run failed: D1_ERROR: boom");
    expect(html).toContain("Refund needed: 1 x402 payment settled without a result.");
    expect(html.match(/data-flag="alert"/g)?.length).toBeGreaterThanOrEqual(6);
    expect(html).toMatch(/<tr[^>]*data-job="cleanup.daily"[^>]*data-late=""/);
  });

  it("reads the database in one batch of 7 statements plus the session, settings and cached job report", async () => {
    countCalls();
    await render();
    expect(calls.batches).toEqual([OVERVIEW_STATEMENTS]);
    // Поза пакетом: сесія, налаштування (кеш холодний) і підсумок вакансій компаній звіту джерел.
    expect(calls.prepared.length).toBe(OVERVIEW_STATEMENTS + 3);
    expect(calls.prepared.some((sql) => sql.includes("FROM sessions"))).toBe(true);
    expect(calls.prepared.some((sql) => sql.includes("FROM app_settings"))).toBe(true);

    // Другий показ: налаштування й звіт з кешу, пакет той самий.
    calls = { prepared: [], batches: [] };
    await render();
    expect(calls.batches).toEqual([OVERVIEW_STATEMENTS]);
    expect(calls.prepared.length).toBe(OVERVIEW_STATEMENTS + 1);
    expect(jobs.reads).toBe(1);
  });

  it("shows the sign-up settings in one line and says when the job sources cannot be read", async () => {
    exec("INSERT INTO app_settings (key, value_json) VALUES ('signups_open', 'false')");
    jobs.d1 = migratedD1([]).d1;
    const html = await render();
    expect(html).toMatch(/Candidate sign-ups: <b[^>]*>closed<\/b>/);
    expect(html).toMatch(/Company sign-ups: <b[^>]*>open<\/b>/);
    expect(html).toContain("Could not read the job sources");
  });
});
