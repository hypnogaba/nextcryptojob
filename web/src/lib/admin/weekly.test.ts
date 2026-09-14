import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifierFromEnv } from "@/lib/crm/notify";
import { readOnlyJobsDb } from "@/lib/jobs-db";
import { addCompany, addSubscription, addUser, all, crmDb, run, setConsent } from "@/test/crm-fixtures";
import { introEnv, stubNetwork, type Network } from "@/test/intro-fixtures";
import { addScanRun, jobsTestDb } from "@/test/jobs-db";
import type { TestDb } from "@/test/sqlite-d1";
import { loadWeeklyReport, runWeeklyReport, weekStart, weeklyDue, weeklyLines, weeklyMessage } from "./weekly";

/**
 * Щотижневий звіт: понеділок з 08:00 UTC, раз на тиждень, Telegram і пошта разом; кнопка в
 * адмінці шле одразу й понеділкового звіту не забирає. Числа за 7 днів, без демо.
 */

const MONDAY_8 = new Date("2026-09-14T08:00:00Z");
const ADMINS = "boss@example.com";
let db: TestDb;
let net: Network;

beforeEach(() => {
  db = crmDb();
  net = stubNetwork();
  addUser(db.raw, { email: "boss@example.com", visible: false });
  run(db.raw, "UPDATE users SET telegram_id = '4242', created_at = '2026-06-01 00:00:00' WHERE email = 'boss@example.com'");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const deps = (now: Date, force = false) => ({ jobs: null, notifier: notifierFromEnv(introEnv(net)), adminEmails: ADMINS, now, force });

describe("schedule", () => {
  it("is due on Monday from 08:00 UTC, and the week starts on Monday", () => {
    expect(weeklyDue(new Date("2026-09-14T07:00:00Z"))).toBe(false);
    expect(weeklyDue(MONDAY_8)).toBe(true);
    expect(weeklyDue(new Date("2026-09-14T09:00:00Z"))).toBe(true);
    expect(weeklyDue(new Date("2026-09-15T08:00:00Z"))).toBe(false);
    expect(weekStart(new Date("2026-09-20T23:00:00Z"))).toBe("2026-09-14");
    expect(weekStart(MONDAY_8)).toBe("2026-09-14");
  });

  it("sends once a week by Telegram and email; a failed 08:00 run is picked up at 09:00", async () => {
    expect(await runWeeklyReport(db.d1, deps(new Date("2026-09-13T08:00:00Z")))).toMatchObject({ sent: false, skipped: "not_due" });
    const first = await runWeeklyReport(db.d1, deps(MONDAY_8));
    expect(first).toMatchObject({ sent: true, channels: ["telegram", "email"] });
    expect(net.messagesTo("4242")).toHaveLength(1);
    expect(net.mail.map((m) => m.to)).toEqual(["boss@example.com"]);
    expect(await runWeeklyReport(db.d1, deps(new Date("2026-09-14T09:00:00Z")))).toMatchObject({ sent: false, skipped: "already_sent" });
    // Наступного понеділка знову.
    expect((await runWeeklyReport(db.d1, deps(new Date("2026-09-21T08:00:00Z")))).sent).toBe(true);
  });

  it("the admin button sends now, any day, and does not use up Monday's report", async () => {
    const wednesday = new Date("2026-09-16T12:00:00Z");
    expect((await runWeeklyReport(db.d1, deps(wednesday, true))).sent).toBe(true);
    expect((await runWeeklyReport(db.d1, deps(wednesday, true))).sent).toBe(true);
    expect((await runWeeklyReport(db.d1, deps(new Date("2026-09-21T08:00:00Z")))).sent).toBe(true);
    expect(all(db.raw, "SELECT key, times FROM owner_alerts ORDER BY key")).toEqual([
      { key: "weekly-preview", times: 2 },
      { key: "weekly:2026-09-21", times: 1 },
    ]);
  });
});

describe("content", () => {
  it("counts visitors, new people, brief completion, digests, companies, open requests and problems for 7 days, without demo", async () => {
    const now = new Date("2026-09-14T08:00:00Z");
    run(db.raw, `INSERT INTO visit_days (day, path_group, ref_host, views, uniques) VALUES
      ('2026-09-10', 'home', 'direct', 40, 25), ('2026-09-12', 'jobs', '', 10, 0), ('2026-09-03', 'home', 'direct', 20, 10)`);
    const fresh = addUser(db.raw);
    run(db.raw, "UPDATE users SET created_at = '2026-09-10 10:00:00', onboarding_step = 'done' WHERE id = ?", fresh);
    setConsent(db.raw, fresh, "scoring", true);
    const halfway = addUser(db.raw);
    run(db.raw, "UPDATE users SET created_at = '2026-09-11 10:00:00', onboarding_step = 'roles' WHERE id = ?", halfway);
    const older = addUser(db.raw);
    run(db.raw, "UPDATE users SET created_at = '2026-09-03 10:00:00' WHERE id = ?", older);
    const demo = addUser(db.raw);
    run(db.raw, "UPDATE users SET created_at = '2026-09-12 10:00:00', is_demo = 1 WHERE id = ?", demo);
    run(db.raw, `INSERT INTO digest_runs (id, user_id, local_date, status, jobs, created_at) VALUES
      ('d1', ?, '2026-09-12', 'sent', 5, '2026-09-12 07:05:00'), ('d2', ?, '2026-09-13', 'failed', 5, '2026-09-13 07:05:00')`, fresh, fresh);
    const co = addCompany(db.raw, { name: "Acme" });
    run(db.raw, "UPDATE companies SET created_at = '2026-09-12 10:00:00' WHERE id = ?", co);
    addSubscription(db.raw, co);
    const demoCo = addCompany(db.raw, { name: "Demo Labs" });
    run(db.raw, "UPDATE companies SET created_at = '2026-09-12 10:00:00', is_demo = 1 WHERE id = ?", demoCo);
    const agency = addCompany(db.raw, { name: "Hire3", kind: "agency", status: "pending_review" });
    run(db.raw, `INSERT INTO agency_applications (id, company_id, contact_name, contact_email, website, country, clients_text, data_use_text, no_resale_ack)
      VALUES ('app_1', ?, 'M', 'm@hire3.io', 'https://hire3.io', 'DE', 'DeFi', 'Hiring', 1)`, agency);
    run(db.raw, "INSERT INTO cron_runs (job, cron, started_at, ms, ok, error) VALUES ('webhooks.deliver', '*/5 * * * *', '2026-09-13 10:00:00', 5, 0, 'boom')");

    const t = jobsTestDb();
    addScanRun(t.raw, { id: "s1", startedAt: "2026-09-12T04:30:00.000Z", status: "ok" });
    addScanRun(t.raw, { id: "s2", startedAt: "2026-09-13T04:30:00.000Z", status: "partial" });
    t.raw.exec(`INSERT INTO source_state (source, status, fail_days, failed_at, checked_at) VALUES
      ('a:1', 'failing', 2, 'x', 'x'), ('a:2', 'dead', 9, 'x', 'x'), ('a:3', 'failing', 1, 'x', 'x')`);

    const r = await loadWeeklyReport(db.d1, readOnlyJobsDb(t.d1), now);
    expect(r.visitors).toEqual({ views: 50, uniques: 25, prevUniques: 10 });
    expect(r.users).toEqual({ newUsers: 2, prevNewUsers: 1, briefDone: 1, total: 4 });
    expect(r.digests).toEqual({ sent: 1, failed: 1, empty: 0 });
    expect(r.companies).toMatchObject({ newCompanies: 2, active: 1 });
    expect(r.requests).toMatchObject({ agencies: 1 });
    expect(r.problems).toMatchObject({ scans: { runs: 2, notOk: 1 }, failingSources: 1, deadSources: 1, cronFailures: [{ job: "webhooks.deliver", n: 1 }] });

    const lines = weeklyLines(r).sections.flatMap((s) => [s.head, ...s.lines]).join("\n");
    expect(lines).toContain("25 unique visitors (+150% vs the week before)");
    expect(lines).toContain("Visit to sign-up: 8%");
    expect(lines).toContain("2 new sign-ups (+100% vs the week before), 4 in total");
    expect(lines).toContain("1 of 2 new people finished the brief (50%)");
    expect(lines).toContain("1 agency application to review");
    expect(lines).toContain("1 job source failing 2+ scans in a row");
    expect(lines).toContain("Scheduled job webhooks.deliver failed 1 time");
    const msg = weeklyMessage(r, "https://nextcryptojob.xyz");
    expect(msg.email.subject).toBe("NextCryptoJob weekly report, 2026-09-07 to 2026-09-14");
    expect(msg.telegramHtml).toContain('<a href="https://nextcryptojob.xyz/admin">Open admin</a>');
  });
});
