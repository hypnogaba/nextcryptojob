import { beforeEach, describe, expect, it } from "vitest";
import type { Mailer, MailMessage } from "@/lib/mail";
import { addApiKey, addUser, all, contextFor, crmDb } from "@/test/crm-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { PaymentRequired, runAction } from "./actions";
import { listApplicationsForAdmin, loadApplication, parseApplication, reviewApplication, submitApplication, type ApplicationInput } from "./agency";
import { closeCompany, CompanyError, registerCompany, updateCompanySettings } from "./company";
import { inviteMember } from "./team";
import { ActionError } from "./types";

let db: TestDb;
beforeEach(() => {
  db = crmDb();
});

const ORIGIN = "https://nextcryptojob.xyz";

async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}

function fakeMailer(): Mailer & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return { sent, send: async (m) => void sent.push(m) };
}

const FORM = {
  contact_name: "Ann Lee",
  contact_email: "ann@hire.co",
  website: "hire.co",
  country: "GB",
  clients_text: "Seed to Series B DeFi protocols in Europe.",
  volume_text: "3 to 5",
  data_use_text: "Only to contact candidates about roles our clients hire for.",
  no_resale_ack: "on",
};

function application(): ApplicationInput {
  const res = parseApplication(FORM);
  if (!res.ok) throw new Error(JSON.stringify(res.errors));
  return res.value;
}

async function agency() {
  const ann = addUser(db.raw, { email: "ann@hire.co" });
  const { companyId } = await registerCompany(db.d1, { id: ann, email: "ann@hire.co" }, {
    name: "Hire Co",
    website: "https://hire.co",
    domain: "hire.co",
    country: "GB",
    kind: "agency",
  });
  const admin = addUser(db.raw, { email: "owner@example.com" });
  return { ann, companyId, admin, ctx: () => contextFor(db, { sessionUserId: ann }) };
}

describe("agency application form", () => {
  it("needs every required answer and the no-resale promise", () => {
    const res = parseApplication({ ...FORM, contact_email: "nope", clients_text: "", no_resale_ack: "" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(Object.keys(res.errors).sort()).toEqual(["clients_text", "contact_email", "no_resale_ack"]);
    expect(application()).toMatchObject({ website: "https://hire.co", country: "GB", volumeText: "3 to 5" });
  });
});

describe("agency waiting for review", () => {
  it("sends the application once; while pending, CRM actions are blocked and settings work", async () => {
    const { companyId, ctx } = await agency();
    const sent = await submitApplication(await ctx(), application());
    expect(sent.resubmitted).toBe(false);
    expect(await loadApplication(db.d1, companyId)).toMatchObject({ status: "pending", contactName: "Ann Lee" });
    // Друге натискання: та сама заявка, без другого рядка й другого запису в журналі.
    expect(await submitApplication(await ctx(), application())).toEqual({ applicationId: sent.applicationId, resubmitted: false });
    expect(all(db.raw, "SELECT COUNT(*) AS n FROM agency_applications")).toEqual([{ n: 1 }]);

    const c = await ctx();
    expect(await failure(runAction("search_candidates", { filters: {} }, c))).toMatchObject({ code: "company_not_active", status: 403 });
    expect(await failure(runAction("get_candidate", { candidate_id: crypto.randomUUID() }, c))).toMatchObject({ code: "company_not_active" });
    expect(await failure(inviteMember(c, "bob@hire.co", { origin: ORIGIN, mailer: null }))).toMatchObject({ code: "company_not_active" });
    // Ключ агенції теж нічого не може до схвалення.
    const key = await addApiKey(db.raw, companyId);
    const agent = await contextFor(db, { authorization: `Bearer ${key.key}` });
    expect(await failure(runAction("search_candidates", { filters: {} }, agent))).toMatchObject({ code: "company_not_active" });

    // Налаштування й шапка (get_account) працюють.
    await updateCompanySettings(c, { name: "Hire Co Ltd", website: "https://hire.co", domain: "hire.co", country: "GB", about: null, xHandle: null });
    const account = await runAction("get_account", {}, c);
    expect(account.output).toMatchObject({ company: { status: "pending_review" }, access: { mode: "none" } });

    expect(all(db.raw, "SELECT action FROM audit_log ORDER BY id")).toEqual([
      { action: "company.create" },
      { action: "agency.apply" },
      { action: "company.update" },
    ]);
  });

  it("only the owner sends it; a company that is not an agency has nothing to send", async () => {
    const dana = addUser(db.raw, { email: "dana@acme.io" });
    await registerCompany(db.d1, { id: dana, email: "dana@acme.io" }, {
      name: "Acme",
      website: "https://acme.io",
      domain: "acme.io",
      country: "FR",
      kind: "company",
    });
    const err = await failure(submitApplication(await contextFor(db, { sessionUserId: dana }), application()));
    expect(err).toBeInstanceOf(CompanyError);
    expect(err).toMatchObject({ code: "application_not_open" });
  });
});

describe("admin review", () => {
  it("Approve: the agency gets access and the email 'Your agency account is approved'", async () => {
    const { companyId, admin, ctx } = await agency();
    const { applicationId } = await submitApplication(await ctx(), application());
    expect((await listApplicationsForAdmin(db.d1)).map((a) => [a.companyName, a.status, a.applicantEmail, a.domainVerified])).toEqual([
      ["Hire Co", "pending", "ann@hire.co", true],
    ]);

    const mailer = fakeMailer();
    const res = await reviewApplication(db.d1, { userId: admin }, { applicationId, decision: "approve", note: "" }, { mailer, origin: ORIGIN });
    expect(res).toEqual({ ok: true, status: "approved", companyId, emailed: true });
    expect(mailer.sent.map((m) => [m.to, m.subject])).toEqual([["ann@hire.co", "Your agency account is approved"]]);
    expect(mailer.sent[0].text).toContain(`${ORIGIN}/company/billing?welcome=1`);

    expect(all(db.raw, "SELECT status, status_reason FROM companies")).toEqual([{ status: "active", status_reason: null }]);
    expect(all(db.raw, "SELECT status, reviewed_by FROM agency_applications")).toEqual([{ status: "approved", reviewed_by: admin }]);
    const [audit] = all<{ actor: string; meta_json: string }>(db.raw, "SELECT actor, meta_json FROM audit_log WHERE action = 'agency.approve'");
    expect(audit.actor).toBe(`admin:${admin}`);
    expect(JSON.parse(audit.meta_json)).toMatchObject({ company_id: companyId, application_id: applicationId });

    // Доступ є: у вебі команда, через API пошук з оплатою x402 (підписки ще немає).
    const c = await ctx();
    expect(c.company).toMatchObject({ status: "active", access: "pay_per_request" });
    await inviteMember(c, "bob@hire.co", { origin: ORIGIN, mailer: null });
    const key = await addApiKey(db.raw, companyId);
    const agent = await contextFor(db, { authorization: `Bearer ${key.key}` });
    expect(await failure(runAction("search_candidates", { filters: {} }, agent))).toBeInstanceOf(PaymentRequired);
    expect(await listApplicationsForAdmin(db.d1)).toEqual([]);

    // Двічі схвалити не можна.
    expect(await reviewApplication(db.d1, { userId: admin }, { applicationId, decision: "approve", note: "" }, { mailer, origin: ORIGIN })).toEqual({
      ok: false,
      reason: "not_open",
    });
  });

  it("Ask for more info: note required, the form opens again, a new answer goes back to review", async () => {
    const { companyId, admin, ctx } = await agency();
    const { applicationId } = await submitApplication(await ctx(), application());
    const opts = { mailer: null, origin: ORIGIN };
    expect(await reviewApplication(db.d1, { userId: admin }, { applicationId, decision: "needs_info", note: " " }, opts)).toEqual({
      ok: false,
      reason: "note_required",
    });

    const res = await reviewApplication(
      db.d1,
      { userId: admin },
      { applicationId, decision: "needs_info", note: "Which clients have you placed people with?" },
      opts,
    );
    expect(res).toMatchObject({ ok: true, status: "needs_info", emailed: false });
    expect(await loadApplication(db.d1, companyId)).toMatchObject({
      status: "needs_info",
      reviewerNote: "Which clients have you placed people with?",
    });
    expect(all(db.raw, "SELECT status FROM companies")).toEqual([{ status: "pending_review" }]);
    expect((await ctx()).company?.access).toBe("none");

    const again = await submitApplication(await ctx(), { ...application(), clientsText: "Aave, Lido and two stealth teams." });
    expect(again).toEqual({ applicationId, resubmitted: true });
    expect(await loadApplication(db.d1, companyId)).toMatchObject({ status: "pending", clientsText: "Aave, Lido and two stealth teams." });
    expect(all(db.raw, "SELECT action FROM audit_log WHERE action LIKE 'agency.%' ORDER BY id")).toEqual([
      { action: "agency.apply" },
      { action: "agency.needs_info" },
      { action: "agency.resubmit" },
    ]);
  });

  it("Reject: reason required; the company is rejected with the reason and cannot use the CRM", async () => {
    const { companyId, admin, ctx } = await agency();
    const { applicationId } = await submitApplication(await ctx(), application());
    const mailer = fakeMailer();
    expect(await reviewApplication(db.d1, { userId: admin }, { applicationId, decision: "reject", note: "" }, { mailer, origin: ORIGIN })).toEqual({
      ok: false,
      reason: "note_required",
    });
    const res = await reviewApplication(
      db.d1,
      { userId: admin },
      { applicationId, decision: "reject", note: "We could not confirm the agency." },
      { mailer, origin: ORIGIN },
    );
    expect(res).toMatchObject({ ok: true, status: "rejected", companyId });
    expect(mailer.sent[0].subject).toBe("Your agency application was not approved");
    expect(all(db.raw, "SELECT status, status_reason FROM companies")).toEqual([
      { status: "rejected", status_reason: "We could not confirm the agency." },
    ]);
    const c = await ctx();
    expect(await failure(runAction("search_candidates", { filters: {} }, c))).toMatchObject({ code: "company_not_active" });
    expect(await failure(submitApplication(c, application()))).toBeInstanceOf(ActionError);
  });
});

describe("agency edge cases", () => {
  it("two first submits at the same time give one application and no error", async () => {
    const { companyId, ctx } = await agency();
    const c = await ctx();
    const [a, b] = await Promise.all([submitApplication(c, application()), submitApplication(c, application())]);
    expect(a.applicationId).toBe(b.applicationId);
    expect(all(db.raw, "SELECT COUNT(*) AS n FROM agency_applications WHERE company_id = ?", companyId)).toEqual([{ n: 1 }]);
    expect(all(db.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'agency.apply'")).toEqual([{ n: 1 }]);
  });

  it("a closed agency is not approved and gets no email", async () => {
    const { admin, ctx } = await agency();
    const { applicationId } = await submitApplication(await ctx(), application());
    await closeCompany(await ctx(), { stripe: null });
    const mailer = fakeMailer();
    for (const decision of ["approve", "needs_info", "reject"] as const) {
      expect(
        await reviewApplication(db.d1, { userId: admin }, { applicationId, decision, note: "x" }, { mailer, origin: ORIGIN }),
      ).toEqual({ ok: false, reason: "not_pending" });
    }
    expect(mailer.sent).toEqual([]);
    expect(all(db.raw, "SELECT status FROM companies")).toEqual([{ status: "closed" }]);
    expect(all(db.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'agency.%' AND action <> 'agency.apply'")).toEqual([{ n: 0 }]);
  });

  it("mails only verified member emails, never the contact email typed into the form", async () => {
    const tg = addUser(db.raw, { email: null, telegram: "ann_tg" });
    await registerCompany(db.d1, { id: tg, email: null }, {
      name: "Hire Co",
      website: "https://hire.co",
      domain: "hire.co",
      country: "GB",
      kind: "agency",
    });
    const { applicationId } = await submitApplication(await contextFor(db, { sessionUserId: tg }), application());
    const admin = addUser(db.raw, { email: "owner@example.com" });
    const mailer = fakeMailer();
    const res = await reviewApplication(db.d1, { userId: admin }, { applicationId, decision: "approve", note: "" }, { mailer, origin: ORIGIN });
    expect(res).toMatchObject({ ok: true, status: "approved", emailed: false });
    expect(mailer.sent).toEqual([]);
  });
});
