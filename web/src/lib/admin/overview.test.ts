import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OVERVIEW_NOW, seedOverview } from "@/test/admin-fixtures";
import { ALL_MIGRATIONS, all, crmDb } from "@/test/crm-fixtures";
import { migratedD1 } from "@/test/sqlite-d1";
import type { JobSourcesReport } from "./job-sources";
import {
  dueAt,
  localHour,
  loadOverview,
  nextDigestRun,
  OVERVIEW_STATEMENTS,
  overviewFlags,
  type Overview,
} from "./overview";

/**
 * Головна адмінки на справжньому SQLite з усіма міграціями: числа звірено з рядками
 * test/admin-fixtures.ts, пакет один і в ньому не більше OVERVIEW_STATEMENTS інструкцій.
 */

function spyDb(d1: D1Database) {
  const batches: number[] = [];
  let prepared = 0;
  const db = {
    ...d1,
    prepare: (sql: string) => (prepared++, d1.prepare(sql)),
    batch: (s: D1PreparedStatement[]) => (batches.push(s.length), d1.batch(s)),
  } as D1Database;
  return { db, batches, prepared: () => prepared };
}

async function seeded(): Promise<{ o: Overview; batches: number[]; prepared: number }> {
  const t = crmDb();
  seedOverview(t.raw);
  const spy = spyDb(t.d1);
  const o = await loadOverview(spy.db, OVERVIEW_NOW);
  return { o, batches: spy.batches, prepared: spy.prepared() };
}

describe("loadOverview", () => {
  it("runs one batch of at most 7 statements, however many rows there are", async () => {
    const { o, batches, prepared } = await seeded();
    expect(batches).toEqual([OVERVIEW_STATEMENTS]);
    expect(prepared).toBe(OVERVIEW_STATEMENTS);
    expect(OVERVIEW_STATEMENTS).toBeLessThanOrEqual(8);
    expect(o.statements).toBe(OVERVIEW_STATEMENTS);
  });

  it("counts candidates, sign-in methods, the onboarding funnel, digest channels and pauses", async () => {
    const { o } = await seeded();
    expect(o.candidates).toEqual({
      total: 4,
      today: 1,
      d7: 2,
      d30: 3,
      emailOnly: 2,
      telegramOnly: 1,
      both: 1,
      briefStarted: 3,
      briefDone: 2,
      xVerified: 1,
      wallets: 1,
      cards: 1,
      visible: 1,
      channelTelegram: 2,
      channelEmail: 2,
      paused: 1,
    });
  });

  it("counts scores, the queue, the last engine write, formula versions and the last quality run", async () => {
    const { o } = await seeded();
    expect(o.scores).toMatchObject({
      usersScored: 2,
      queued: 2,
      running: 1,
      oldestQueuedAt: Date.parse("2026-09-13T11:30:00Z"),
      failed24h: 1,
      done24h: 1,
      lastEngineAt: Date.parse("2026-09-13T11:55:00Z"),
      quality: { version: "v6", nearPct: 85.7, exactPct: 42.9, people: 49, passed: true, runAt: Date.parse("2026-09-12T10:00:00Z") },
    });
    expect([...o.scores.versions].sort((a, b) => a.version.localeCompare(b.version))).toEqual([
      { version: "v5", users: 1, published: false },
      { version: "v6", users: 1, published: true },
    ]);
  });

  it("gives seven UTC days of digests with sent, failed, empty and channels, and the top failure reason", async () => {
    const { o } = await seeded();
    const d = o.digests;
    expect(d.days.map((x) => x.day)).toEqual([
      "2026-09-13", "2026-09-12", "2026-09-11", "2026-09-10", "2026-09-09", "2026-09-08", "2026-09-07",
    ]);
    expect(d.days[0]).toEqual({ day: "2026-09-13", runs: 3, sent: 1, failed: 1, empty: 0, pending: 1, telegram: 1, email: 0, jobsSent: 5 });
    expect(d.days[1]).toEqual({ day: "2026-09-12", runs: 2, sent: 1, failed: 0, empty: 1, pending: 0, telegram: 0, email: 1, jobsSent: 3 });
    expect(d.days[3]).toMatchObject({ runs: 1, failed: 1 });
    expect(d.days[2].runs).toBe(0);
    expect(d.failureReasons).toEqual([{ reason: "Telegram 403: bot was blocked by the user", n: 2 }]);
    expect(d.newestRunAt).toBe(Date.parse("2026-09-13T11:00:00Z"));
    expect(d.stuckPending).toBe(1);
    // u1 і u3 можуть отримати добірку (u2 на паузі, в u4 немає ролей); о 12:05 UTC у Парижі 14:05, це година u1.
    expect(d.eligible).toBe(2);
    expect(d.nextRunAt).toBe(Date.parse("2026-09-13T12:05:00Z"));
    expect(d.dueNext).toBe(1);
  });

  it("counts companies by access, the CRM activity of the last 7 days, company jobs and payments", async () => {
    const { o } = await seeded();
    expect(o.companies).toEqual({
      trial: 1,
      subscribed: 1,
      payPerRequest: 1,
      pendingReview: 1,
      suspended: 0,
      closed: 1,
      agenciesPending: 1,
      members: 1,
      invitesOpen: 1,
      searches7d: 3,
      views7d: 2,
      intros7d: 1,
      intros: { accepted: 1, pending: 1 },
      openJobs: 2,
      liveJobs: 1,
      applyClicksTotal: 7,
      xQueue: 1,
    });
    expect(o.payments).toEqual({
      x402: { settled: 2, verified: 1, unconfirmed: 1 },
      settledCents: 550,
      noResultWaiting: 1,
      stale: 2,
      subscriptions: [
        { provider: "manual", status: "active", n: 1 },
        { provider: "manual", status: "trialing", n: 1 },
      ],
    });
  });

  it("shows the last run of every cron job, failures in 24 h, and which jobs are late", async () => {
    const { o } = await seeded();
    expect(o.cron.available).toBe(true);
    const byJob = Object.fromEntries(o.cron.jobs.map((j) => [j.job, j]));
    expect(o.cron.jobs.map((j) => j.job)).toEqual([
      "intros.expire", "webhooks.deliver", "jobs.expire", "saved_searches.alert", "x402.stale", "owner.alerts", "owner.weekly",
      "cleanup.daily",
    ]);
    expect(byJob["intros.expire"]).toMatchObject({ ok: true, late: false, lastAt: Date.parse("2026-09-13T11:55:00Z"), counts: { expired: 0 } });
    expect(byJob["webhooks.deliver"]).toMatchObject({ ok: false, late: false, failed24h: 2, lastOkAt: null, error: "D1_ERROR: boom", ms: 1200 });
    expect(byJob["jobs.expire"].late).toBe(false);
    // Жодного запуску, а журнал ведеться 33 години: запізнилась.
    expect(byJob["x402.stale"]).toMatchObject({ lastAt: null, late: true });
    // Щоденна задача 33 години тому: більше за 26 год.
    expect(byJob["cleanup.daily"]).toMatchObject({ ok: true, late: true });
  });

  it("works on an empty database: zeros, seven empty days, and cron with no runs yet", async () => {
    const o = await loadOverview(crmDb().d1, OVERVIEW_NOW);
    expect(o.candidates.total).toBe(0);
    expect(o.scores.quality).toBeNull();
    expect(o.digests.days).toHaveLength(7);
    expect(o.payments.x402).toEqual({});
    expect(o.cron.firstRecordedAt).toBeNull();
    // Порожній журнал: запізнення бачимо лише в 5-хвилинних задачах.
    expect(o.cron.jobs.filter((j) => j.late).map((j) => j.job)).toEqual(["intros.expire", "webhooks.deliver"]);
  });

  it("still loads without migration 0019 and says cron history is missing", async () => {
    // Лише без 0019; 0021 (is_demo) від неї не залежить і накочена.
    const t = migratedD1(ALL_MIGRATIONS.filter((m) => !m.startsWith("0019")));
    const o = await loadOverview(t.d1, OVERVIEW_NOW);
    expect(o.cron.available).toBe(false);
    expect(o.cron.error).toContain("0019");
    expect(o.statements).toBe(OVERVIEW_STATEMENTS - 1);
    expect(overviewFlags(o, { report: null, error: null })[0]).toMatchObject({ level: "alert", text: expect.stringContaining("0019") });
  });
});

describe("overviewFlags", () => {
  const report = (lastScanAt: number, stale: boolean): JobSourcesReport =>
    ({
      sources: [],
      company: { openJobs: 0, liveJobs: 0, liveWithSalary: 0, newestAt: null },
      totals: {
        liveJobs: 0, crawlLiveJobs: 0, companyLiveJobs: 0, activeSources: 0, staleSources: 0, allSources: 0,
        lastScan: { at: lastScanAt, status: "ok" }, scannerStale: stale,
      },
      computedAt: lastScanAt,
    }) as JobSourcesReport;

  it("raises late and failed cron jobs, stuck digests, unpublished formulas, payments and to-dos with links", async () => {
    const { o } = await seeded();
    const flags = overviewFlags(o, { report: report(OVERVIEW_NOW.getTime() - 3_600_000, false), error: null });
    const text = flags.map((f) => `${f.level}: ${f.text}`);
    expect(text).toEqual([
      "alert: Cron x402.stale (0 * * * *): no run recorded yet.",
      "alert: Cron owner.alerts (0 * * * *): no run recorded yet.",
      "alert: Cron owner.weekly (0 * * * *): no run recorded yet.",
      "alert: Cron cleanup.daily (0 3 * * *) is late: last run 33 h ago.",
      "alert: Cron webhooks.deliver: the last run failed: D1_ERROR: boom",
      "alert: Formula v5 has no passed quality run: companies do not see the scores of 1 person.",
      "alert: Stuck: 1 digest run pending for over 30 min.",
      "alert: Refund needed: 1 x402 payment settled without a result.",
      "alert: Check by hand: 2 x402 payments stuck or unconfirmed.",
      "todo: Review: 1 agency application.",
      "todo: Post on X: 1 job in the queue.",
    ]);
    expect(flags.find((f) => f.text.includes("Refund"))?.href).toBe("/admin/payments");
    expect(flags.find((f) => f.text.includes("agency"))?.href).toBe("/admin/agency-applications");
  });

  it("flags the engine idle for a day with a queue, and a scanner that missed its daily run", async () => {
    const { o } = await seeded();
    const later = { ...o, now: Date.parse("2026-09-14T12:30:00Z") }; // понеділок
    const flags = overviewFlags(later, { report: report(Date.parse("2026-09-11T03:00:00Z"), true), error: null });
    expect(flags.map((f) => f.text)).toEqual(
      expect.arrayContaining([
        "Scoring engine idle for 24 h with 2 queued.",
        "Job scanner missed its scheduled daily run (04:30 UTC); last scan 3 d ago.",
      ]),
    );
    expect(flags.find((f) => f.text.startsWith("Job scanner"))).toMatchObject({ level: "alert", href: "/admin/sources" });

    // Звіт каже, що скан на місці: прапорця немає.
    const onTime = overviewFlags(o, { report: report(Date.parse("2026-09-11T03:00:00Z"), false), error: null });
    expect(onTime.find((f) => f.text.startsWith("Job scanner"))).toBeUndefined();

    const unread = overviewFlags(o, { report: null, error: "no such table: jobs_cache" });
    expect(unread.find((f) => f.href === "/admin/sources")?.text).toContain("no such table");
  });

  it("flags a queue whose oldest job waits over an hour, and no digest run for 26 h while people can get one", async () => {
    const { o } = await seeded();
    const at = Date.parse("2026-09-14T13:30:00Z");
    const stuck = overviewFlags(
      { ...o, now: at, scores: { ...o.scores, lastEngineAt: at - 60_000 } },
      { report: null, error: null },
    ).map((f) => f.text);
    expect(stuck).toContain("Scoring queue: the oldest job has waited 26 h.");
    expect(stuck).toContain("No digest run for 26 h while 2 people can get one.");
  });
});

describe("next digest run", () => {
  it("is :05 of this hour until then, else of the next hour", () => {
    expect(nextDigestRun(new Date("2026-09-13T12:04:59Z")).toISOString()).toBe("2026-09-13T12:05:00.000Z");
    expect(nextDigestRun(new Date("2026-09-13T12:05:00Z")).toISOString()).toBe("2026-09-13T13:05:00.000Z");
    expect(nextDigestRun(new Date("2026-09-13T23:30:00Z")).toISOString()).toBe("2026-09-14T00:05:00.000Z");
  });

  it("counts people whose own hour it is, an unknown zone counts as UTC", () => {
    const at = new Date("2026-09-13T12:05:00Z");
    expect(localHour(at, "Europe/Kyiv")).toBe(15);
    expect(localHour(at, "Mars/Base")).toBe(12);
    expect(dueAt([[15, "Europe/Kyiv", 3], [12, "", 2], [12, "Mars/Base", 1], [7, "UTC", 9]], at)).toBe(6);
  });
});

describe("migration 0019", () => {
  it("adds cron_runs, app_settings and the digest_runs date index, and applies twice without errors", () => {
    const { raw } = crmDb();
    const sql = all<{ name: string }>(raw, "SELECT name FROM sqlite_master WHERE name IN ('cron_runs', 'app_settings', 'idx_cron_runs_job', 'idx_digest_runs_created') ORDER BY name");
    expect(sql.map((r) => r.name)).toEqual(["app_settings", "cron_runs", "idx_cron_runs_job", "idx_digest_runs_created"]);
    const plan = all<{ detail: string }>(raw, "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM digest_runs WHERE created_at >= '2026-09-07 00:00:00'");
    expect(plan.map((r) => r.detail).join(" ")).toContain("idx_digest_runs_created");
    expect(() => raw.exec(readFileSync(new URL("../../../../db/migrations/0019_admin_home.sql", import.meta.url), "utf8"))).not.toThrow();
    expect(all(raw, "SELECT name FROM schema_migrations WHERE name = '0019_admin_home'")).toHaveLength(1);
  });
});
