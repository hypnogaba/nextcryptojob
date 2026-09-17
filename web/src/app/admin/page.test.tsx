import { readFileSync } from "node:fs";
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

/**
 * Міграція 0023 (contact_messages) накочена на проді, але не входить у типовий список тестової
 * бази: інші тести перевіряють саме життя без неї. Тут накочуємо її на цю базу.
 */
function withContactMessages(): void {
  harness.raw.exec(readFileSync(new URL("../../../../db/migrations/0023_launch.sql", import.meta.url), "utf8"));
}

async function render(query: Record<string, string> = {}): Promise<string> {
  return renderToStaticMarkup(await AdminOverviewPage({ searchParams: Promise.resolve(query) })).replaceAll("&#x27;", "'");
}

/**
 * Поза пакетом головної: відвідування за 30 днів (пакет з 4), серія графіка (пакет з 2),
 * демо (пакет з 2 і версія формули), листи без відповіді, нові люди.
 */
const SIDE_BATCHES = [4, 2, 2];
const SIDE_STATEMENTS = 4 + 2 + 2 + 1 + 1 + 1;

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

  it("is one panel: what needs you, the numbers, the chart, payments and new people", async () => {
    const html = await render();
    expect(html).toContain('aria-current="page"');
    for (const title of ["Needs you", "Visitors", "New people"]) {
      expect(html).toContain(`>${title}</h2>`);
    }
    // Службове поїхало на /admin/health, розбори на свої сторінки.
    for (const gone of ["Daily digests", "Health", "Scores", "Candidates", "Companies", "Alerts to you", "Demo company"]) {
      expect(html).not.toContain(`>${gone}</h2>`);
    }
    expect(html).not.toContain("More stats");
    expect(html).toContain('href="/admin/health"');
    expect(html).toMatch(/Jobs live<\/dt><dd[^>]*>2<\/dd>/);
    expect(html).toMatch(/People<\/dt><dd[^>]*>5<\/dd>/);
    expect(html).not.toContain("NextRole");
    expect(jobs.reads).toBe(1);
  });

  it("puts unanswered contact messages first, with who wrote and what they wrote", async () => {
    withContactMessages();
    exec(`INSERT INTO contact_messages (id, email, topic, message, created_at) VALUES
      ('msg_1', 'ada@example.com', 'company', 'We hire a Rust engineer. How much is a listing?', '2026-09-13 09:00:00'),
      ('msg_2', 'old@example.com', 'press', 'Answered already.', '2026-09-12 09:00:00')`);
    exec("UPDATE contact_messages SET answered_at = '2026-09-12 10:00:00' WHERE id = 'msg_2'");
    const html = await render();
    const panel = html.slice(html.indexOf('data-list="messages"'));
    expect(panel).toContain("ada@example.com");
    expect(panel).toContain("We hire a Rust engineer. How much is a listing?");
    expect(panel).toContain("mailto:ada@example.com");
    expect(panel).not.toContain("old@example.com");
    // Листи стоять перед рештою того, що чекає.
    expect(html.indexOf('data-list="messages"')).toBeLessThan(html.indexOf('data-list="flags"'));
  });

  it("lists what needs attention: late and failed cron jobs, stuck digests, payments waiting for a refund", async () => {
    const html = await render();
    expect(html).toContain("Cron x402.stale (0 * * * *): no run recorded yet.");
    expect(html).toContain("Cron cleanup.daily (0 3 * * *) is late: last run 33 h ago.");
    expect(html).toContain("Cron webhooks.deliver: the last run failed: D1_ERROR: boom");
    expect(html).toContain("Refund needed: 1 x402 payment settled without a result.");
    expect(html.match(/data-flag="alert"/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it("reads the database in one batch of 7 statements plus the side queries", async () => {
    countCalls();
    await render();
    expect([...calls.batches].sort()).toEqual([OVERVIEW_STATEMENTS, ...SIDE_BATCHES].sort());
    // Поза пакетом: сесія, налаштування (кеш холодний) і підсумок вакансій компаній звіту джерел.
    expect(calls.prepared.length).toBe(OVERVIEW_STATEMENTS + SIDE_STATEMENTS + 3);

    // Другий показ: налаштування й звіт з кешу, пакет той самий.
    calls = { prepared: [], batches: [] };
    await render();
    expect([...calls.batches].sort()).toEqual([OVERVIEW_STATEMENTS, ...SIDE_BATCHES].sort());
    expect(calls.prepared.length).toBe(OVERVIEW_STATEMENTS + SIDE_STATEMENTS + 1);
    expect(jobs.reads).toBe(1);
  });

  it("shows the sign-up settings in one line and says when the job sources cannot be read", async () => {
    exec("INSERT INTO app_settings (key, value_json) VALUES ('signups_open', 'false')");
    jobs.d1 = migratedD1([]).d1;
    const html = await render();
    expect(html).toMatch(/Candidate sign-ups: <b[^>]*>closed<\/b>/);
    expect(html).toMatch(/Company sign-ups: <b[^>]*>open<\/b>/);
    expect(html).toContain("Could not read job sources");
  });

  it("counts visitors, views and sign-ups over 30 days", async () => {
    exec(`INSERT INTO visit_days (day, path_group, ref_host, views, uniques) VALUES
      ('2026-09-13', 'home', 'google.com', 30, 20), ('2026-09-13', 'jobs', '', 12, 0), ('2026-09-12', 'card', 'x.com', 9, 5)`);
    const html = await render();
    expect(html).toMatch(/Visitors, 30 days<\/dt><dd[^>]*>25<\/dd>/);
    // Реєстрації за 30 днів з users (адмін з червня не рахується): u1 13.09, u2 10.09, u3 20.08.
    expect(html).toMatch(/Sign-ups, 30 days<\/dt><dd[^>]*>3<\/dd>/);
    expect(html).toMatch(/Visit to sign-up<\/dt><dd[^>]*>12%<\/dd>/);
    expect(html).toContain("google.com");
    expect(html).toContain("Shared cards");
    expect(html).toContain("no third-party scripts, no cookies");
  });

  it("draws the chart by days, weeks or months", async () => {
    exec(`INSERT INTO visit_days (day, path_group, ref_host, views, uniques) VALUES ('2026-09-13', 'home', 'google.com', 30, 20)`);
    const byDay = await render();
    expect(byDay).toContain('data-point="2026-09-13"');
    expect(byDay).toMatch(/data-step="week"/);
    expect(byDay).toContain("Unique visitors, left axis");

    const byMonth = await render({ step: "month" });
    // 12 календарних місяців: вересень останній.
    expect(byMonth).toContain('data-point="2026-09"');
    expect(byMonth).toContain('data-point="2025-10"');
    expect(byMonth).toMatch(/aria-current="page"[^>]*data-step="month"|data-step="month"[^>]*aria-current="page"/);

    const byWeek = await render({ step: "week" });
    // Тиждень з понеділка: 13.09 це неділя, тож тиждень 07.09.
    expect(byWeek).toContain('data-point="2026-09-07"');
  });

  it("lists the newest people first with where they stopped in the brief", async () => {
    exec(`INSERT INTO users (id, email, telegram_username, onboarding_step, created_at) VALUES
      ('n1', NULL, 'newbie', 'roles', '2026-09-13 11:00:00'),
      ('n2', 'done@example.com', NULL, 'done', '2026-09-13 11:30:00')`);
    const html = await render();
    const table = html.slice(html.indexOf('data-table="new-users"'));
    expect(table.indexOf("done@example.com")).toBeLessThan(table.indexOf("@newbie"));
    expect(table).toContain("Brief: roles");
    expect(table).toContain(">Done<");
    expect(table).toContain('href="/admin/scores/n1"');
  });

  it("hides the payments panel while there is nothing in it", async () => {
    resetHarness({ ADMIN_EMAILS: "boss@example.com" } as never);
    exec("INSERT INTO users (id, email, telegram_id, created_at) VALUES ('boss', 'boss@example.com', '555', '2026-06-01 00:00:00')");
    await createSession("boss", "email");
    const html = await render();
    expect(html).not.toContain(">Payments</h2>");
    expect(html).toContain(">Needs you</h2>");
  });
});
