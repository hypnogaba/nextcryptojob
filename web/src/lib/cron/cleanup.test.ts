import { beforeEach, describe, expect, it } from "vitest";
import { findStalePayments } from "@/lib/x402/server";
import { addCompany, addUsage, addUser, all, crmDb, run } from "@/test/crm-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { countStalePayments, dailyCleanup } from "./cleanup";

/** Щоденне прибирання: видаляє лише прострочене, шматками, повтор нічого не ламає. */

let db: TestDb;
const NOW = new Date("2026-09-12T03:00:00Z");

beforeEach(() => {
  db = crmDb();
});

const count = (table: string) => Number(all<{ n: number }>(db.raw, `SELECT COUNT(*) AS n FROM ${table}`)[0].n);

describe("dailyCleanup", () => {
  it("removes expired sessions, old login codes, stale rate counters, old bot updates, usage older than 400 days, yesterday's visitor hashes and old owner alerts, and keeps the rest", async () => {
    const user = addUser(db.raw);
    run(db.raw, "INSERT INTO sessions (id, user_id, expires_at) VALUES ('dead', ?, '2026-09-11 00:00:00'), ('live', ?, '2026-10-01 00:00:00')", user, user);
    run(
      db.raw,
      `INSERT INTO login_codes (email, code_hash, expires_at) VALUES
         ('a@x.io', 'h1', '2026-09-10 00:00:00'), ('b@x.io', 'h2', '2026-09-11 12:00:00'), ('c@x.io', 'h3', '2026-09-12 03:10:00')`,
    );
    run(
      db.raw,
      `INSERT INTO auth_attempts (key, attempts, window_start, blocked_until) VALUES
         ('login:old', 3, '2026-09-10 00:00:00', NULL),
         ('login:blocked', 9, '2026-09-10 00:00:00', '2026-09-13 00:00:00'),
         ('login:fresh', 1, '2026-09-12 02:00:00', NULL)`,
    );
    run(db.raw, "INSERT INTO webhook_updates (update_id, seen_at) VALUES (1, '2026-09-08 00:00:00'), (2, '2026-09-11 00:00:00')");
    const co = addCompany(db.raw);
    addUsage(db.raw, 3, { companyId: co, action: "search_candidates", at: "2025-08-01 00:00:00" });
    addUsage(db.raw, 2, { companyId: co, action: "search_candidates", at: "2026-09-01 00:00:00" });
    // Журнал cron живе 30 днів (0019): рядок з 12.08 уже старший, з 14.08 ще ні.
    run(
      db.raw,
      `INSERT INTO cron_runs (job, cron, started_at, ms, ok) VALUES
         ('intros.expire', '*/5 * * * *', '2026-08-12 02:55:00', 10, 1),
         ('intros.expire', '*/5 * * * *', '2026-08-14 03:00:00', 12, 1)`,
    );

    // Хеші відвідувачів (0021) живуть до вчора: 10.09 стирається, 11.09 і 12.09 ні.
    run(db.raw, "INSERT INTO visit_visitors (day, hash) VALUES ('2026-09-10', 'a'), ('2026-09-11', 'b'), ('2026-09-12', 'c')");
    // Сповіщення власнику (0021) живуть 60 днів.
    run(
      db.raw,
      `INSERT INTO owner_alerts (key, kind, sent_at) VALUES ('cron:old', 'cron', '2026-07-01 00:00:00'),
         ('cron:new', 'cron', '2026-09-01 00:00:00')`,
    );

    expect(await dailyCleanup(db.d1, { now: NOW })).toEqual({
      sessions: 1,
      login_codes: 1,
      auth_attempts: 1,
      webhook_updates: 1,
      usage_events: 3,
      cron_runs: 1,
      visit_visitors: 1,
      owner_alerts: 1,
    });
    expect(all(db.raw, "SELECT day FROM visit_visitors ORDER BY day")).toEqual([{ day: "2026-09-11" }, { day: "2026-09-12" }]);
    expect(all(db.raw, "SELECT key FROM owner_alerts")).toEqual([{ key: "cron:new" }]);
    expect(all(db.raw, "SELECT started_at FROM cron_runs")).toEqual([{ started_at: "2026-08-14 03:00:00" }]);
    expect(all(db.raw, "SELECT id FROM sessions")).toEqual([{ id: "live" }]);
    expect(all(db.raw, "SELECT email FROM login_codes ORDER BY email")).toEqual([{ email: "b@x.io" }, { email: "c@x.io" }]);
    expect(all(db.raw, "SELECT key FROM auth_attempts ORDER BY key")).toEqual([{ key: "login:blocked" }, { key: "login:fresh" }]);
    expect(count("usage_events")).toBe(2);

    // Повтор: видаляти нічого.
    expect(Object.values(await dailyCleanup(db.d1, { now: NOW })).every((n) => n === 0)).toBe(true);
  });

  it("is bounded: at most chunk x maxChunks rows per table per run, the rest next time", async () => {
    const user = addUser(db.raw);
    for (let i = 0; i < 7; i++) run(db.raw, "INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, '2026-09-01 00:00:00')", `s${i}`, user);
    expect((await dailyCleanup(db.d1, { now: NOW, chunk: 2, maxChunks: 2 })).sessions).toBe(4);
    expect(count("sessions")).toBe(3);
    expect((await dailyCleanup(db.d1, { now: NOW, chunk: 2, maxChunks: 2 })).sessions).toBe(3);
    expect(count("sessions")).toBe(0);
  });
});

describe("countStalePayments", () => {
  it("counts the same payments the admin list shows", async () => {
    const insert = (id: string, status: string, createdAt: string) =>
      run(
        db.raw,
        `INSERT INTO x402_payments (id, payload_hash, request_hash, network, asset, pay_to, amount_atomic, amount_usd_cents,
                                    action, channel, status, facilitator, created_at)
         VALUES (?, ?, 'rh', 'eip155:84532', 'usdc', 'payto', '500000', 50, 'search_candidates', 'rest', ?, 'x402org', ?)`,
        id,
        `ph_${id}`,
        status,
        createdAt,
      );
    const now = new Date();
    const sql = (ms: number) => new Date(now.getTime() - ms).toISOString().replace("T", " ").slice(0, 19);
    insert("pay_old_verified", "verified", sql(10 * 60_000));
    insert("pay_new_verified", "verified", sql(60_000));
    insert("pay_unconfirmed", "unconfirmed", sql(60_000));
    insert("pay_settled", "settled", sql(60 * 60_000));
    expect(await countStalePayments(db.d1, now)).toEqual({ stalePayments: 2 });
    expect((await findStalePayments(db.d1)).length).toBe(2);
  });
});
