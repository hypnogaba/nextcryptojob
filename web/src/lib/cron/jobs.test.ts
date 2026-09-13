import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newId } from "@/lib/ids";
import { addCompany, addMember, addSubscription, addUser, all, crmDb, run } from "@/test/crm-fixtures";
import { BOT_TOKEN, fakeEmail, linkTelegram, nextTelegramId, stubNetwork, type Network } from "@/test/intro-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { runCron, SCHEDULE, CRONS, type CronEnv } from "./index";
import { closeExpiredJobs } from "./jobs";

/**
 * Прострочені вакансії (специфікація 5.6): закрити, зняти з черги X, написати власникам
 * компанії один раз; пачка й межа часу, як в інших задачах cron.
 */

let db: TestDb;
let net: Network;
let company: string;
let ownerTelegram: string;

beforeEach(() => {
  db = crmDb();
  net = stubNetwork();
  company = addCompany(db.raw, { name: "Acme Labs" });
  addSubscription(db.raw, company);
  const owner = addUser(db.raw, { email: "dana@acme.io", visible: false });
  ownerTelegram = nextTelegramId();
  linkTelegram(db, owner, ownerTelegram);
  addMember(db.raw, company, owner, "owner");
  // Член команди (не власник) листа не отримує.
  addMember(db.raw, company, addUser(db.raw, { email: "lee@acme.io", visible: false }), "member");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const notifier = () => ({ botToken: BOT_TOKEN, mailer: null, origin: "https://nextcryptojob.xyz" });

function addJob(o: { expires: string; status?: string; title?: string; x?: string } = { expires: "-1 hour" }): string {
  const id = newId("job");
  run(
    db.raw,
    `INSERT INTO company_jobs (id, company_id, status, title, roles, apply_url, created_via, published_at, expires_at, x_post_state)
     VALUES (?, ?, ?, ?, '["engineer"]', 'https://acme.io/jobs', 'web', datetime('now', '-60 days'), datetime('now', ?), ?)`,
    id,
    company,
    o.status ?? "open",
    o.title ?? "Solidity engineer",
    o.expires,
    o.x ?? "none",
  );
  return id;
}

const job = (id: string) => all<{ status: string; x_post_state: string; closed_at: string | null }>(db.raw, "SELECT status, x_post_state, closed_at FROM company_jobs WHERE id = ?", id)[0];

describe("closeExpiredJobs", () => {
  it("closes open jobs past their 60 days, takes them off the X queue and tells the owner once", async () => {
    const expired = addJob({ expires: "-1 hour", x: "queued", title: "Rust  engineer" });
    const live = addJob({ expires: "+1 day" });
    const draft = addJob({ expires: "-1 day", status: "draft" });

    const res = await closeExpiredJobs(db.d1, { notifier: notifier() });
    expect(res).toEqual({ closed: 1, notified: 1, notDelivered: 0, deferred: 0, errors: 0 });
    expect(job(expired)).toMatchObject({ status: "closed", x_post_state: "skipped" });
    expect(job(expired).closed_at).not.toBeNull();
    expect(job(live).status).toBe("open");
    expect(job(draft).status).toBe("draft");

    const sent = net.messagesTo(ownerTelegram);
    expect(sent).toHaveLength(1);
    // parse_mode HTML: лапки назви екрановано.
    expect(String(sent[0].payload.text)).toContain("Your job &quot;Rust engineer&quot; expired. Reopen it to keep it in digests.");
    expect(String(sent[0].payload.text)).toContain(`https://nextcryptojob.xyz/company/jobs/${expired}`);
    expect(all(db.raw, "SELECT actor, action FROM audit_log")).toEqual([{ actor: `${company}:system`, action: "job.expire" }]);

    // Повторний запуск нічого не закриває й другого листа не шле.
    expect((await closeExpiredJobs(db.d1, { notifier: notifier() })).closed).toBe(0);
    expect(net.messagesTo(ownerTelegram)).toHaveLength(1);
  });

  it("an owner without Telegram gets an email; nothing configured is counted, not thrown", async () => {
    run(db.raw, "UPDATE users SET telegram_id = NULL, channel = 'email' WHERE email = 'dana@acme.io'");
    addJob({ expires: "-2 hours" });
    const mailed = await closeExpiredJobs(db.d1, { notifier: { ...notifier(), mailer: null } });
    expect(mailed).toMatchObject({ closed: 1, notified: 0, notDelivered: 1 });

    addJob({ expires: "-1 hour", title: "Growth lead" });
    const res = await closeExpiredJobs(db.d1, { env: { EMAIL: fakeEmail(net), SITE_URL: "https://nextcryptojob.xyz" } });
    expect(res).toMatchObject({ closed: 1, notified: 1 });
    expect(net.mail.map((m) => [m.to, m.subject])).toEqual([["dana@acme.io", 'Your job "Growth lead" expired']]);
  });

  it("takes a bounded batch, oldest first, and stops at the deadline leaving the rest for the next run", async () => {
    const ids = ["-3 hours", "-2 hours", "-1 hour"].map((expires) => addJob({ expires }));
    expect(await closeExpiredJobs(db.d1, { notifier: notifier(), limit: 2 })).toMatchObject({ closed: 2 });
    expect(ids.map((id) => job(id).status)).toEqual(["closed", "closed", "open"]);

    const more = addJob({ expires: "-1 minute" });
    let t = 0;
    const res = await closeExpiredJobs(db.d1, { notifier: notifier(), clock: () => new Date(t++ === 0 ? 0 : 10_000), deadline: 5_000 });
    expect(res).toMatchObject({ closed: 1, deferred: 1 });
    expect([job(ids[2]).status, job(more).status]).toEqual(["closed", "open"]);
  });

  it("a job the company closed in the meantime is not closed again and nobody is written to", async () => {
    const id = addJob({ expires: "-1 hour" });
    const d1 = db.d1;
    // Між читанням пачки й закриттям компанія закрила вакансію сама.
    const wrapped = {
      prepare: (sql: string) => {
        if (sql.startsWith("UPDATE company_jobs SET status = 'closed'")) run(db.raw, "UPDATE company_jobs SET status = 'closed' WHERE id = ?", id);
        return d1.prepare(sql);
      },
      batch: d1.batch.bind(d1),
    } as unknown as D1Database;
    expect(await closeExpiredJobs(wrapped, { notifier: notifier() })).toMatchObject({ closed: 0, notified: 0 });
    expect(net.messagesTo(ownerTelegram)).toEqual([]);
    expect(all(db.raw, "SELECT action FROM audit_log")).toEqual([]);
  });

  it("runs every hour from the scheduler", async () => {
    expect(SCHEDULE[CRONS.hourly].map((j) => j.name)).toContain("jobs.expire");
    addJob({ expires: "-1 hour" });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const report = await runCron(CRONS.hourly, { DB: db.d1, TELEGRAM_BOT_TOKEN: BOT_TOKEN } as CronEnv, {
      schedule: { [CRONS.hourly]: SCHEDULE[CRONS.hourly].filter((j) => j.name === "jobs.expire") },
    });
    expect(report.jobs).toEqual([expect.objectContaining({ job: "jobs.expire", ok: true, counts: expect.objectContaining({ closed: 1, notified: 1 }) })]);
  });
});
