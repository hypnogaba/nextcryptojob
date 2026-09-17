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

// База вакансій: справжній SQLite, і лічильники запитів до неї: reads = звіт джерел (jobs_cache),
// any = будь-який запит (дошки й збої джерел читаються щоразу, звіт джерел кешується).
const jobs = vi.hoisted(() => ({ d1: null as unknown as D1Database, reads: 0, any: 0 }));
vi.mock("@/lib/jobs-db", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/jobs-db")>();
  return {
    ...mod,
    jobsDb: () => {
      const db = mod.readOnlyJobsDb(jobs.d1);
      return {
        ...db,
        all: (sql: string, ...params: unknown[]) => {
          jobs.any++;
          if (/FROM jobs_cache/.test(sql)) jobs.reads++;
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
  jobs.any = 0;
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
    expect(jobs.any).toBe(0);
  });

  it("is not found for an admin who signed in through Telegram", async () => {
    await createSession("boss", "telegram");
    await expect(render()).rejects.toBeInstanceOf(NotFoundCalled);
    expect(jobs.any).toBe(0);
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

  it("folds sources with fewer than 50 live jobs behind a toggle and keeps the big ones in view", async () => {
    const t = jobsTestDb();
    for (let i = 0; i < 55; i++) addCachedJob(t.raw, { source: "ashby:kraken", company: "Kraken", fetchedAt: "2026-09-12T04:40:00.000Z" });
    addCachedJob(t.raw, { source: "greenhouse:coinbase", company: "Coinbase", fetchedAt: "2026-09-12T04:40:00.000Z" });
    addCachedJob(t.raw, { source: "lever:moonpay", company: "MoonPay", fetchedAt: "2026-09-12T04:40:00.000Z" });
    addScanRun(t.raw, { id: "s1", startedAt: "2026-09-12T04:30:00.000Z" });
    jobs.d1 = t.d1;
    await createSession("boss", "email");
    const html = await render();
    const big = html.slice(html.indexOf('data-table="big-sources"'), html.indexOf("data-small-sources"));
    expect(big).toContain(">Kraken</a>");
    expect(big).not.toContain("Coinbase");
    expect(html).toContain('data-small-sources="2"');
    expect(html).toContain("Show 2 small sources");
    const small = html.slice(html.indexOf('data-table="small-sources"'));
    expect(small).toContain(">Coinbase</a>");
    expect(small).toContain(">MoonPay</a>");
  });

  it("lists the ecosystem and fund boards with platform, decision, companies found, last discovery and employers added", async () => {
    const t = jobsTestDb();
    addScanRun(t.raw, { id: "s1", startedAt: "2026-09-12T04:30:00.000Z" });
    t.raw.exec(`INSERT INTO job_boards (slug, label, kind, url, platform, platform_id, companies, decision, reason, checked_at) VALUES
      ('solana', 'Solana', 'ecosystem', 'https://jobs.solana.com/jobs', 'getro', '858', 251, 'discover', 'weekly', '2026-09-14'),
      ('paradigm', 'Paradigm', 'fund', 'https://www.paradigm.xyz/portfolio', 'consider', NULL, 80, 'manual', 'Consider forbids reading', '2026-09-14'),
      ('a16z', 'a16z crypto', 'fund', 'https://a16zcrypto.com/jobs', 'custom', NULL, NULL, 'skip', 'Mixed portfolio, mostly not crypto', '2026-09-14')`);
    t.raw.exec(`INSERT INTO companies (slug, name, ats_provider, ats_slug, discovered_via) VALUES
      ('jito', 'Jito', 'ashby', 'jito', 'getro:858'), ('drift', 'Drift', 'ashby', 'drift', 'getro:858'),
      ('eigen', 'Eigen', 'greenhouse', 'eigen', 'portfolio:paradigm'), ('coinbase', 'Coinbase', 'greenhouse', 'coinbase', 'seed')`);
    t.raw.exec(`INSERT INTO scan_runs (id, kind, started_at, status, jobs_new, notes) VALUES ('d1', 'discover', '2026-09-06T05:30:00.000Z', 'ok', 2,
      '{"getro":[{"board":"solana","id":858,"label":"Solana","companies":251,"withJobs":120,"known":90,"added":2,"hostedOnly":5}]}')`);
    jobs.d1 = t.d1;
    await createSession("boss", "email");
    const html = await render();
    expect(html).toContain("We do not copy jobs from these boards");
    const row = (slug: string) => html.slice(html.indexOf(`data-board="${slug}"`), html.indexOf("</tr>", html.indexOf(`data-board="${slug}"`)));
    expect(row("solana")).toContain('href="https://jobs.solana.com/jobs"');
    expect(row("solana")).toContain("Getro");
    expect(row("solana")).toContain("Discover");
    expect(row("solana")).toContain("251");
    expect(row("solana")).toContain("120 hiring");
    expect(row("solana")).toContain("90 already known, 2 new");
    expect(row("solana")).toMatch(/>2(<|\s)/);
    expect(row("paradigm")).toContain("Manual");
    expect(row("paradigm")).toContain("Consider");
    expect(row("paradigm")).toMatch(/>1(<|\s)/);
    expect(row("a16z")).toContain("Skip");
    expect(row("a16z")).toContain("Mixed portfolio, mostly not crypto");
    expect(html).toContain("Board reading");
  });

  it("shows failing and dead sources with what to do", async () => {
    const t = jobsTestDb();
    addScanRun(t.raw, { id: "s1", startedAt: "2026-09-12T04:30:00.000Z" });
    t.raw.exec(`INSERT INTO source_state (source, status, fail_days, last_error, failed_at, checked_at) VALUES
      ('lever:gone', 'dead', 8, 'HTTP 404', '2026-09-12T04:31:00.000Z', '2026-09-12T04:31:00.000Z'),
      ('ashby:slow', 'failing', 2, 'timeout after 15000 ms', '2026-09-12T04:31:00.000Z', '2026-09-12T04:31:00.000Z'),
      ('greenhouse:blip', 'failing', 1, 'HTTP 502', '2026-09-12T04:31:00.000Z', '2026-09-12T04:31:00.000Z')`);
    jobs.d1 = t.d1;
    await createSession("boss", "email");
    const html = await render();
    expect(html).toContain('id="problems"');
    expect(html).toContain("2</b> need a look");
    expect(html).toContain("lever:gone");
    expect(html).toContain("Dead: read once a week only");
    expect(html).toContain("Failing 2 scans");
    expect(html).toContain("usually heals by itself");
  });

  it("says so when the jobs DB cannot be read", async () => {
    // Порожня база без таблиць, як локальний JOBS_DB у `next dev` без накочених db/jobs.
    jobs.d1 = migratedD1([]).d1;
    const html = await render();
    expect(html).toContain("Could not read the job sources");
    expect(html).toContain("no such table");
  });
});
