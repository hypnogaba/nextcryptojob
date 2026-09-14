import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetJobSourcesCache } from "@/lib/admin/job-sources";
import { createSession } from "@/lib/auth/session";
import { exec, resetHarness } from "@/test/harness";
import { addCachedJob, addScanRun, addSource, jobsTestDb } from "@/test/jobs-db";
import { migratedD1 } from "@/test/sqlite-d1";
import AdminSourcesPage from "./page";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);

class NotFoundCalled extends Error {}
vi.mock("next/navigation", async () => ({
  ...(await import("@/test/harness")).navigationModule,
  notFound: (): never => {
    throw new NotFoundCalled("notFound()");
  },
}));

// База вакансій: справжній SQLite, і лічильник запитів до неї.
const jobs = vi.hoisted(() => ({ d1: null as unknown as D1Database, reads: 0 }));
vi.mock("@/lib/jobs-db", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/jobs-db")>();
  return {
    ...mod,
    jobsDb: () => {
      const db = mod.readOnlyJobsDb(jobs.d1);
      return {
        ...db,
        all: (sql: string, ...params: unknown[]) => {
          jobs.reads++;
          return db.all(sql, ...params);
        },
      };
    },
  };
});

const NOW = new Date("2026-09-12T15:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  resetJobSourcesCache();
  resetHarness({ ADMIN_EMAILS: "boss@example.com" } as never);
  exec("INSERT INTO users (id, email, telegram_id) VALUES ('boss', 'boss@example.com', '555')");
  exec("INSERT INTO users (id, email) VALUES ('ada', 'ada@example.com')");

  const t = jobsTestDb();
  addCachedJob(t.raw, { source: "greenhouse:coinbase", company: "Coinbase", fetchedAt: "2026-09-12T04:40:00.000Z" });
  addCachedJob(t.raw, { source: "lever:moonpay", company: "MoonPay", fetchedAt: "2026-09-08T04:40:00.000Z" });
  addCachedJob(t.raw, { source: "board:web3career", fetchedAt: "2026-09-12T04:40:00.000Z" });
  addSource(t.raw, { name: "board:web3career", label: "Web3.career", kind: "jsonld", siteUrl: "https://web3.career" });
  addScanRun(t.raw, { id: "s1", startedAt: "2026-09-12T04:30:00.000Z" });
  jobs.d1 = t.d1;
  jobs.reads = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

async function render(): Promise<string> {
  return renderToStaticMarkup(await AdminSourcesPage());
}

describe("/admin/sources access", () => {
  it("is not found for someone who is not an admin, and never reads the jobs DB", async () => {
    await createSession("ada", "email");
    await expect(render()).rejects.toBeInstanceOf(NotFoundCalled);
    expect(jobs.reads).toBe(0);
  });

  it("is not found for an admin who signed in through Telegram", async () => {
    await createSession("boss", "telegram");
    await expect(render()).rejects.toBeInstanceOf(NotFoundCalled);
    expect(jobs.reads).toBe(0);
  });

  it("is not found without a session", async () => {
    await expect(render()).rejects.toBeInstanceOf(NotFoundCalled);
  });
});

describe("/admin/sources for an admin", () => {
  beforeEach(async () => {
    await createSession("boss", "email");
  });

  it("lists each source as a link with its counts, flags the stale one, and adds company jobs", async () => {
    const html = await render();
    expect(html).toContain("Job sources");
    expect(html).toContain('href="https://job-boards.greenhouse.io/coinbase"');
    expect(html).toContain(">Coinbase</a>");
    expect(html).toContain('href="https://jobs.lever.co/moonpay"');
    expect(html).toContain("Company jobs (NextCryptoJob)");
    // MoonPay скан не бачив 4 доби: застигла, Coinbase ні.
    expect(html.match(/data-stale=""/g)).toHaveLength(1);
    expect(html).toContain('href="https://web3.career/"');
    expect(html).toContain("runs every day, weekends included, at 04:30 UTC");
    expect(html).not.toContain("NextRole");
    expect(html).toMatch(/<tr[^>]*data-stale=""[^>]*>.*?moonpay/);
    expect(html).toContain("Updated just now");
    expect(html).not.toContain("has not run for over");
  });

  it("serves the cached report for 10 minutes, then reads again", async () => {
    await render();
    vi.setSystemTime(new Date(NOW.getTime() + 5 * 60_000));
    const cached = await render();
    expect(jobs.reads).toBe(1);
    expect(cached).toContain("Updated 5 min ago");

    vi.setSystemTime(new Date(NOW.getTime() + 11 * 60_000));
    const fresh = await render();
    expect(jobs.reads).toBe(2);
    expect(fresh).toContain("Updated just now");
  });

  it("says so when the jobs DB cannot be read", async () => {
    // Порожня база без таблиць, як локальний JOBS_DB у `next dev` без накочених db/jobs.
    jobs.d1 = migratedD1([]).d1;
    const html = await render();
    expect(html).toContain("Could not read the job sources");
    expect(html).toContain("no such table");
  });
});
