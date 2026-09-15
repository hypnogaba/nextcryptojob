import { beforeEach, describe, expect, it } from "vitest";
import { addCompany, addMember, addUser, all, crmDb, run } from "@/test/crm-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { sendExpiryReminders } from "./billing-reminders";

/**
 * Нагадування за 3 дні до кінця оплаченого USDC-періоду (п.8, 15.09): x402 і Solana Pay
 * дають той самий рядок subscriptions (provider='usdc'), тож нагадування не розрізняє походження.
 */

const NOW = new Date("2026-09-15T12:00:00Z");
const sentMail: { to: string; subject: string }[] = [];
const notifier = {
  botToken: undefined,
  mailer: { send: async (m: { to: string; subject: string }) => void sentMail.push({ to: m.to, subject: m.subject }) },
  origin: "https://nextcryptojob.xyz",
};

let db: TestDb;
let company: string;
let owner: string;

function subscription(o: { end: string; start?: string; reminded?: boolean; status?: string }): string {
  const id = crypto.randomUUID();
  run(
    db.raw,
    `INSERT INTO subscriptions (id, company_id, provider, status, current_period_start, current_period_end, currency, amount_cents, reminded_at)
     VALUES (?, ?, 'usdc', ?, ?, ?, 'usdc', 10000, ?)`,
    id, company, o.status ?? "active", o.start ?? "2026-08-15 12:00:00", o.end, o.reminded ? "2026-09-15 00:00:00" : null,
  );
  return id;
}

beforeEach(() => {
  db = crmDb();
  company = addCompany(db.raw);
  owner = addUser(db.raw, { email: "owner@acme.io" });
  addMember(db.raw, company, owner, "owner");
});

describe("sendExpiryReminders", () => {
  it("reminds an active usdc period ending within 3 days, and marks it so it is not reminded twice", async () => {
    const subId = subscription({ end: "2026-09-17 12:00:00" }); // за 2 дні
    const res = await sendExpiryReminders(db.d1, { notifier, now: NOW });
    expect(res).toEqual({ checked: 1, reminded: 1, notDelivered: 0 });
    expect(sentMail).toEqual([{ to: "owner@acme.io", subject: "Your NextCryptoJob access ends on September 17, 2026" }]);
    const row = all<{ reminded_at: string | null }>(db.raw, "SELECT reminded_at FROM subscriptions WHERE id = ?", subId)[0];
    expect(row!.reminded_at).not.toBeNull();

    // Другий запуск того самого періоду нічого не робить.
    const again = await sendExpiryReminders(db.d1, { notifier, now: NOW });
    expect(again).toEqual({ checked: 0, reminded: 0, notDelivered: 0 });
  });

  it("does not remind a period ending more than 3 days out", async () => {
    subscription({ end: "2026-09-25 12:00:00" }); // за 10 днів
    await expect(sendExpiryReminders(db.d1, { notifier, now: NOW })).resolves.toEqual({ checked: 0, reminded: 0, notDelivered: 0 });
  });

  it("does not remind a period that already ended", async () => {
    subscription({ end: "2026-09-14 12:00:00" }); // учора
    await expect(sendExpiryReminders(db.d1, { notifier, now: NOW })).resolves.toEqual({ checked: 0, reminded: 0, notDelivered: 0 });
  });

  it("does not remind when the company already paid the next period", async () => {
    subscription({ end: "2026-09-17 12:00:00" });
    subscription({ start: "2026-09-17 12:00:00", end: "2026-10-17 12:00:00" }); // наступний період уже оплачений
    const res = await sendExpiryReminders(db.d1, { notifier, now: NOW });
    expect(res).toEqual({ checked: 0, reminded: 0, notDelivered: 0 });
  });

  it("skips a period already reminded", async () => {
    subscription({ end: "2026-09-17 12:00:00", reminded: true });
    expect(await sendExpiryReminders(db.d1, { notifier, now: NOW })).toEqual({ checked: 0, reminded: 0, notDelivered: 0 });
  });

  it("counts notDelivered when the company has no reachable channel", async () => {
    run(db.raw, "UPDATE users SET email = NULL WHERE id = ?", owner);
    subscription({ end: "2026-09-17 12:00:00" });
    const res = await sendExpiryReminders(db.d1, { notifier, now: NOW });
    expect(res).toEqual({ checked: 1, reminded: 1, notDelivered: 1 });
  });
});
