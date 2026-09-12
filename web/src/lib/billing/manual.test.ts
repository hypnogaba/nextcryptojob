import { beforeEach, describe, expect, it } from "vitest";
import type { TestDb } from "@/test/sqlite-d1";
import { addCompany, addMember, addSubscription, addUser, all, crmDb } from "@/test/crm-fixtures";
import { hasAccess, loadBillingState } from "./access";
import { grantManualAccess, listCompaniesForAdmin, revokeManualAccess } from "./manual";
import { days } from "@/test/stripe-fixtures";

let db: TestDb;
let company: string;
let admin: string;

beforeEach(() => {
  db = crmDb();
  company = addCompany(db.raw, { name: "Acme Labs" });
  admin = addUser(db.raw, { email: "hypnogaba@gmail.com" });
});

function grant(o: Partial<Parameters<typeof grantManualAccess>[1]> = {}) {
  return grantManualAccess(db.d1, {
    companyId: company,
    status: "active",
    periodEnd: days(30),
    note: "Hackathon jury",
    adminUserId: admin,
    ...o,
  });
}

describe("manual access", () => {
  it("grant gives access until the chosen end, with the admin and note recorded", async () => {
    expect(await hasAccess(db.d1, company)).toBe(false);
    const res = await grant();
    expect(res).toMatchObject({ ok: true, closed: 0 });
    expect(await hasAccess(db.d1, company)).toBe(true);

    const [row] = all(db.raw, "SELECT provider, status, granted_by, note, trial_end FROM subscriptions");
    expect(row).toEqual({ provider: "manual", status: "active", granted_by: admin, note: "Hackathon jury", trial_end: null });
    const state = await loadBillingState(db.d1, company);
    expect(state?.current).toMatchObject({ provider: "manual", status: "active", note: "Hackathon jury" });
  });

  it("a manual trial counts as the trial of the company", async () => {
    await grant({ status: "trialing", periodEnd: days(14) });
    const state = await loadBillingState(db.d1, company);
    expect(state?.current?.status).toBe("trialing");
    expect(state?.trialAvailable).toBe(false);
  });

  it("a new grant replaces the previous manual one", async () => {
    await grant({ periodEnd: days(10) });
    const res = await grant({ periodEnd: days(90), note: "Extended for partner" });
    expect(res).toMatchObject({ ok: true, closed: 1 });
    const rows = all<{ status: string; note: string }>(db.raw, "SELECT status, note FROM subscriptions ORDER BY rowid");
    expect(rows).toEqual([
      { status: "canceled", note: "Hackathon jury" },
      { status: "active", note: "Extended for partner" },
    ]);
  });

  it("revoke removes manual access at once and leaves Stripe and USDC alone", async () => {
    await grant();
    addSubscription(db.raw, company, { provider: "usdc", status: "active", end: undefined });
    const res = await revokeManualAccess(db.d1, { companyId: company, adminUserId: admin });
    expect(res).toEqual({ ok: true, closed: 1 });
    const rows = all<{ provider: string; status: string }>(db.raw, "SELECT provider, status FROM subscriptions ORDER BY provider");
    expect(rows).toEqual([
      { provider: "manual", status: "canceled" },
      { provider: "usdc", status: "active" },
    ]);
    // USDC-період досі дає доступ; без нього доступу немає.
    expect(await hasAccess(db.d1, company)).toBe(true);
  });

  it("after revoke without other subscriptions the company is back to pay per request", async () => {
    await grant();
    await revokeManualAccess(db.d1, { companyId: company, adminUserId: admin });
    expect(await hasAccess(db.d1, company)).toBe(false);
  });

  it("writes the audit log as the admin, without the note", async () => {
    await grant();
    await revokeManualAccess(db.d1, { companyId: company, adminUserId: admin });
    const log = all<{ actor: string; action: string; meta_json: string }>(
      db.raw,
      "SELECT actor, action, meta_json FROM audit_log ORDER BY id",
    );
    expect(log.map((l) => [l.actor, l.action])).toEqual([
      [`admin:${admin}`, "access.grant"],
      [`admin:${admin}`, "access.revoke"],
    ]);
    expect(JSON.parse(log[0].meta_json)).toMatchObject({ company_id: company, status: "active" });
    expect(log[0].meta_json).not.toContain("Hackathon");
  });

  it("refuses a past end, an end over a year away, an empty note, an unknown company", async () => {
    expect(await grant({ periodEnd: days(-1) })).toEqual({ ok: false, reason: "invalid_period" });
    expect(await grant({ periodEnd: days(400) })).toEqual({ ok: false, reason: "invalid_period" });
    expect(await grant({ note: "   " })).toEqual({ ok: false, reason: "note_required" });
    expect(await grant({ note: "x".repeat(201) })).toEqual({ ok: false, reason: "note_too_long" });
    expect(await grant({ status: "past_due" as never })).toEqual({ ok: false, reason: "invalid_status" });
    expect(await grant({ companyId: "co_AAAAAAAAAAAAAAAAAAAA" })).toEqual({ ok: false, reason: "not_found" });
    expect(all(db.raw, "SELECT * FROM subscriptions")).toEqual([]);
  });
});

describe("listCompaniesForAdmin", () => {
  it("shows access, the latest subscription, members and whether manual access can be revoked", async () => {
    addMember(db.raw, company, admin, "owner");
    const other = addCompany(db.raw, { name: "Beta Agency", kind: "agency", status: "pending_review" });
    await grant({ status: "trialing", periodEnd: days(7) });
    const rows = await listCompaniesForAdmin(db.d1);
    expect(rows.find((r) => r.id === company)).toMatchObject({
      name: "Acme Labs",
      access: "subscription",
      members: 1,
      provider: "manual",
      subStatus: "trialing",
      manualActive: true,
    });
    expect(rows.find((r) => r.id === other)).toMatchObject({
      kind: "agency",
      access: "none",
      provider: null,
      manualActive: false,
    });
  });
});
