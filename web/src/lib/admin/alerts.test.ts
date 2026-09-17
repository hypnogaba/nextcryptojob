import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifierFromEnv } from "@/lib/crm/notify";
import { readOnlyJobsDb } from "@/lib/jobs-db";
import { addCompany, addUser, all, crmDb, run } from "@/test/crm-fixtures";
import { BOT_TOKEN, introEnv, stubNetwork, type Network } from "@/test/intro-fixtures";
import { addScanRun, jobsTestDb } from "@/test/jobs-db";
import type { TestDb } from "@/test/sqlite-d1";
import {
  agencyAlert,
  claimAlert,
  collectAlerts,
  ownerAlertMessage,
  ownerRecipients,
  runOwnerAlerts,
  sendOwnerAlert,
  type OwnerAlert,
} from "./alerts";

/**
 * Сповіщення власнику: кому (Telegram, якщо є, інакше пошта), що в тексті (що сталось, чому
 * важливо, що зробити, посилання), дедуплікація (не частіше разу на добу), і що саме
 * щогодинна перевірка вважає проблемою.
 */

const NOW = new Date("2026-09-14T10:00:00Z");
const ADMINS = "boss@example.com";
let db: TestDb;
let net: Network;

const notifier = () => notifierFromEnv(introEnv(net));

beforeEach(() => {
  db = crmDb();
  net = stubNetwork();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ALERT: OwnerAlert = {
  key: "scan:s1",
  kind: "scan",
  title: "Job scan failed",
  why: "No jobs were saved in this run.",
  next: "Open Job sources.",
  href: "/admin/sources",
};

describe("recipients and message", () => {
  it("sends to the admin's Telegram when the account has one, else by email to ADMIN_EMAILS", async () => {
    addUser(db.raw, { email: "boss@example.com", visible: false });
    expect(await ownerRecipients(db.d1, ADMINS)).toEqual([{ email: "boss@example.com", telegramId: null }]);
    run(db.raw, "UPDATE users SET telegram_id = '4242' WHERE email = 'boss@example.com'");
    expect(await ownerRecipients(db.d1, ADMINS)).toEqual([{ email: "boss@example.com", telegramId: "4242" }]);

    const res = await sendOwnerAlert(db.d1, ALERT, { notifier: notifier(), adminEmails: ADMINS, now: NOW });
    expect(res).toMatchObject({ sent: true, channels: ["telegram"] });
    expect(net.messagesTo("4242")).toHaveLength(1);
    expect(net.mail).toEqual([]);
  });

  it("falls back to email when the admin has no Telegram, and says what happened, why, what to do and where", async () => {
    addUser(db.raw, { email: "boss@example.com", visible: false });
    await sendOwnerAlert(db.d1, ALERT, { notifier: notifier(), adminEmails: ADMINS, now: NOW });
    expect(net.mail).toHaveLength(1);
    const mail = net.mail[0];
    expect(mail.to).toBe("boss@example.com");
    expect(mail.subject).toBe("NextCryptoJob: Job scan failed");
    expect(mail.text).toContain("Why it matters: No jobs were saved in this run.");
    expect(mail.text).toContain("What to do: Open Job sources.");
    expect(mail.text).toContain("https://nextcryptojob.xyz/admin/sources");
    const tg = ownerAlertMessage(ALERT, "https://nextcryptojob.xyz").telegramHtml;
    expect(tg).toContain("<b>Job scan failed</b>");
    expect(tg).toContain('<a href="https://nextcryptojob.xyz/admin/sources">Open in admin</a>');
    expect(tg).not.toMatch(/\u2014/);
  });

  it("carries the sender and the whole text, so the reply needs no trip to the admin", () => {
    const written: OwnerAlert = {
      ...ALERT,
      title: "New contact message (company) from ada@example.com",
      from: "ada@example.com",
      body: "We hire a Rust engineer.\nWhat does a listing cost?",
    };
    const m = ownerAlertMessage(written, "https://nextcryptojob.xyz");
    expect(m.telegramHtml).toContain("<code>ada@example.com</code>");
    expect(m.telegramHtml).toContain("<blockquote>We hire a Rust engineer.\nWhat does a listing cost?</blockquote>");
    expect(m.email.subject).toBe("NextCryptoJob: New contact message (company) from ada@example.com");
    expect(m.email.text).toContain("From: ada@example.com");
    expect(m.email.text).toContain("What does a listing cost?");
    expect(m.email.html).toContain('href="mailto:ada%40example.com?subject=Re%3A%20your%20message%20to%20NextCryptoJob"');
    expect(m.email.html).toContain("What does a listing cost?");
  });

  it("escapes the sender's text and keeps Telegram under its message limit", () => {
    const m = ownerAlertMessage({ ...ALERT, from: "ada@example.com", body: `<script>x</script> ${"a".repeat(4000)}` }, "https://nextcryptojob.xyz");
    expect(m.telegramHtml).toContain("&lt;script&gt;");
    expect(m.telegramHtml).not.toContain("<script>");
    expect(m.telegramHtml.length).toBeLessThan(4096);
    expect(m.telegramHtml).toContain("…");
    // Обрізає лише Telegram: лист несе текст цілком.
    expect(m.email.text).toContain("a".repeat(4000));
  });
});

describe("dedupe", () => {
  it("sends the same alert at most once per 24 h, then again after the window", async () => {
    addUser(db.raw, { email: "boss@example.com", visible: false });
    const send = (at: Date) => sendOwnerAlert(db.d1, ALERT, { notifier: notifier(), adminEmails: ADMINS, now: at });
    expect((await send(NOW)).sent).toBe(true);
    expect(await send(new Date(NOW.getTime() + 3_600_000))).toMatchObject({ sent: false, skipped: "dedupe" });
    expect(await send(new Date(NOW.getTime() + 23 * 3_600_000))).toMatchObject({ sent: false, skipped: "dedupe" });
    expect((await send(new Date(NOW.getTime() + 25 * 3_600_000))).sent).toBe(true);
    expect(net.mail).toHaveLength(2);
    expect(all(db.raw, "SELECT key, times, channel FROM owner_alerts")).toEqual([{ key: "scan:s1", times: 2, channel: "email" }]);
  });

  it("claims a key once even when two runs race", async () => {
    const a = { key: "cron:x", kind: "cron", summary: "x" };
    const [one, two] = await Promise.all([claimAlert(db.d1, a, NOW), claimAlert(db.d1, a, NOW)]);
    expect([one, two].sort()).toEqual([false, true]);
  });

  it("records a failed delivery and does not retry every hour", async () => {
    addUser(db.raw, { email: "boss@example.com", visible: false });
    net.mailFails = true;
    const res = await sendOwnerAlert(db.d1, ALERT, { notifier: notifier(), adminEmails: ADMINS, now: NOW });
    expect(res.sent).toBe(false);
    expect(all<{ error: string }>(db.raw, "SELECT error FROM owner_alerts")[0].error).toContain("email:");
    expect(await sendOwnerAlert(db.d1, ALERT, { notifier: notifier(), adminEmails: ADMINS, now: NOW })).toMatchObject({ skipped: "dedupe" });
  });

  it("an agency application alerts once, and its update after more info alerts again", async () => {
    addUser(db.raw, { email: "boss@example.com", visible: false });
    const deps = { notifier: notifier(), adminEmails: ADMINS, now: NOW };
    expect((await sendOwnerAlert(db.d1, agencyAlert({ id: "app_1", company: "Hire3", country: "DE" }), deps)).sent).toBe(true);
    expect((await sendOwnerAlert(db.d1, agencyAlert({ id: "app_1", company: "Hire3", country: "DE" }), { ...deps, now: new Date(NOW.getTime() + 3 * 86_400_000) })).sent).toBe(false);
    expect((await sendOwnerAlert(db.d1, agencyAlert({ id: "app_1", company: "Hire3", country: "DE", resubmitted: true }), deps)).sent).toBe(true);
    expect(net.mail.map((m) => m.subject)).toEqual([
      "NextCryptoJob: New agency application: Hire3 (DE)",
      "NextCryptoJob: Agency application updated: Hire3 (DE)",
    ]);
  });
});

describe("collectAlerts", () => {
  const cronJobs = [
    { job: "intros.expire", cron: "*/5 * * * *" },
    { job: "cleanup.daily", cron: "0 3 * * *" },
    { job: "owner.weekly", cron: "0 * * * *" },
  ];

  it("finds a pending agency application, failed and late cron jobs, refunds and a digest failure spike, with no personal data", async () => {
    const co = addCompany(db.raw, { name: "Hire3", kind: "agency", status: "pending_review" });
    run(
      db.raw,
      `INSERT INTO agency_applications (id, company_id, contact_name, contact_email, website, country, clients_text, data_use_text,
                                        no_resale_ack, created_at)
       VALUES ('app_AAAAAAAAAAAAAAAAAAAA', ?, 'Maria Secret', 'maria@hire3.io', 'https://hire3.io', 'DE', 'DeFi', 'Hiring', 1, '2026-09-14 09:00:00')`,
      co,
    );
    run(
      db.raw,
      `INSERT INTO cron_runs (job, cron, started_at, ms, ok, error) VALUES
         ('intros.expire', '*/5 * * * *', '2026-09-14 09:55:00', 10, 0, 'D1_ERROR: boom'),
         ('cleanup.daily', '0 3 * * *', '2026-09-12 03:00:00', 10, 1, NULL)`,
    );
    run(
      db.raw,
      `INSERT INTO x402_payments (id, payload_hash, request_hash, network, asset, pay_to, amount_atomic, amount_usd_cents, action,
                                  channel, status, facilitator, no_result_at)
       VALUES ('pay_1', 'ph1', 'rh', 'eip155:8453', 'usdc', 'p', '500000', 50, 'search_candidates', 'rest', 'settled', 'cdp', '2026-09-14 08:00:00')`,
    );
    const u = addUser(db.raw);
    for (let i = 0; i < 6; i++) {
      run(db.raw, "INSERT INTO digest_runs (id, user_id, local_date, status, jobs, error, created_at) VALUES (?, ?, ?, 'failed', 5, 'Telegram 403: bot was blocked', '2026-09-14 07:05:00')", `dg_f${i}`, u, `2026-09-0${i + 1}`);
    }
    run(db.raw, "INSERT INTO digest_runs (id, user_id, local_date, status, jobs, created_at) VALUES ('dg_s', ?, '2026-09-14', 'sent', 5, '2026-09-14 07:05:00')", u);

    const { alerts, errors } = await collectAlerts(db.d1, { jobs: null, cronJobs, now: NOW });
    expect(errors).toEqual([]);
    const keys = alerts.map((a) => a.key);
    expect(keys).toEqual([
      "agency:app_AAAAAAAAAAAAAAAAAAAA",
      "cron:intros.expire",
      "cron-late:cleanup.daily",
      "x402:no-result",
      "digest:failures",
    ]);
    // Нова задача без жодного запуску (owner.weekly) тривоги не дає.
    expect(keys.join()).not.toContain("owner.weekly");
    const text = JSON.stringify(alerts);
    expect(text).not.toContain("Maria");
    expect(text).not.toContain("maria@hire3.io");
    for (const a of alerts) {
      expect(a.why.length).toBeGreaterThan(10);
      expect(a.next.length).toBeGreaterThan(10);
      expect(a.href.startsWith("/admin")).toBe(true);
    }
  });

  it("reads the jobs DB: failed scan, sources failing 2+ scans or dead, failed discovery", async () => {
    const t = jobsTestDb();
    addScanRun(t.raw, { id: "scan_1", startedAt: "2026-09-14T04:30:00.000Z", status: "partial" });
    addScanRun(t.raw, { id: "disc_1", startedAt: "2026-09-13T05:30:00.000Z", status: "failed", kind: "discover" });
    t.raw.exec(`INSERT INTO source_state (source, status, fail_days, last_error, failed_at, checked_at) VALUES
      ('lever:gone', 'dead', 8, 'HTTP 404', '2026-09-14T04:31:00Z', '2026-09-14T04:31:00Z'),
      ('ashby:slow', 'failing', 2, 'timeout', '2026-09-14T04:31:00Z', '2026-09-14T04:31:00Z'),
      ('greenhouse:blip', 'failing', 1, 'HTTP 502', '2026-09-14T04:31:00Z', '2026-09-14T04:31:00Z')`);
    const { alerts } = await collectAlerts(db.d1, { jobs: readOnlyJobsDb(t.d1), cronJobs: [], now: NOW });
    expect(alerts.map((a) => a.key)).toEqual(["scan:scan_1", "sources:2026-09-14", "discover:disc_1"]);
    const sources = alerts.find((a) => a.kind === "source")!;
    expect(sources.parts?.map((p) => p.key)).toEqual(["source:ashby:slow", "source:lever:gone"]);
  });

  it("says when the scanner missed its daily run", async () => {
    const t = jobsTestDb();
    addScanRun(t.raw, { id: "scan_old", startedAt: "2026-09-12T04:30:00.000Z" });
    const { alerts } = await collectAlerts(db.d1, { jobs: readOnlyJobsDb(t.d1), cronJobs: [], now: NOW });
    expect(alerts.map((a) => a.key)).toContain("scan:missed");
  });

  it("names each failing source at most once a week, even when the daily list repeats", async () => {
    addUser(db.raw, { email: "boss@example.com", visible: false });
    const t = jobsTestDb();
    // Скан, свіжий на обидві дати перевірки: лишаються тільки джерела.
    addScanRun(t.raw, { id: "scan_1", startedAt: "2026-09-16T04:30:00.000Z" });
    t.raw.exec(`INSERT INTO source_state (source, status, fail_days, last_error, failed_at, checked_at) VALUES
      ('ashby:slow', 'failing', 2, 'timeout', '2026-09-14T04:31:00Z', '2026-09-14T04:31:00Z')`);
    const deps = { jobs: readOnlyJobsDb(t.d1), cronJobs: [], notifier: notifier(), adminEmails: ADMINS };
    expect(await runOwnerAlerts(db.d1, { ...deps, now: NOW })).toMatchObject({ sent: 1 });
    expect(await runOwnerAlerts(db.d1, { ...deps, now: new Date(NOW.getTime() + 2 * 86_400_000) })).toMatchObject({ sent: 0, deduped: 1 });
    t.raw.exec(`INSERT INTO source_state (source, status, fail_days, last_error, failed_at, checked_at) VALUES
      ('lever:new', 'failing', 2, 'HTTP 404', '2026-09-16T04:31:00Z', '2026-09-16T04:31:00Z')`);
    expect(await runOwnerAlerts(db.d1, { ...deps, now: new Date(NOW.getTime() + 2 * 86_400_000) })).toMatchObject({ sent: 1 });
    expect(net.mail).toHaveLength(2);
    expect(net.mail[1].text).toContain("lever:new");
    expect(net.mail[1].text).not.toContain("ashby:slow");
  });

  it("works through the Telegram bot token from the environment", () => {
    expect(notifier().botToken).toBe(BOT_TOKEN);
  });
});
