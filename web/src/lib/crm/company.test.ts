import { beforeEach, describe, expect, it, vi } from "vitest";
import { addApiKey, addCompany, addMember, addSubscription, addUser, all, contextFor, crmDb, run } from "@/test/crm-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { runAction } from "./actions";
import {
  closeCompany,
  COMPANIES_PER_DAY,
  COMPANY_TERMS_VERSION,
  CompanyError,
  FORMER_MEMBER,
  listActivity,
  listMemberships,
  loadCompanyProfile,
  memberLabels,
  parseRegistration,
  parseSettings,
  registerCompany,
  updateCompanySettings,
  type RegistrationInput,
} from "./company";
import { ActionError } from "./types";

let db: TestDb;
beforeEach(() => {
  db = crmDb();
});

async function failure(p: Promise<unknown>): Promise<ActionError | CompanyError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ActionError || e instanceof CompanyError) return e;
    throw e;
  }
  throw new Error("expected an error");
}

function input(o: Partial<RegistrationInput> = {}): RegistrationInput {
  return { name: "Acme Labs", website: "https://acme.io", domain: "acme.io", country: "FR", kind: "company", ...o };
}

async function ownerCtx(userId: string, companyId?: string) {
  return contextFor(db, { sessionUserId: userId, companyId: companyId ?? null });
}

describe("registration form", () => {
  it("needs a name, a website, a country, who you hire for and the Company Terms", () => {
    const res = parseRegistration({ name: " ", website: "http://acme.io", country: "ZZ", hiring_for: "" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(Object.keys(res.errors).sort()).toEqual(["country", "hiring_for", "name", "terms", "website"]);
    expect(res.errors.terms).toBe("Accept the Company Terms to continue.");

    const good = parseRegistration({
      name: "  Acme   Labs ",
      website: "www.acme.io",
      country: "fr",
      hiring_for: "agency",
      terms: "on",
    });
    expect(good).toEqual({
      ok: true,
      value: { name: "Acme Labs", website: "https://www.acme.io", domain: "acme.io", country: "FR", kind: "agency" },
    });
  });
});

describe("registerCompany: our own team", () => {
  it("creates an active company with the person as owner, the accepted terms and an audit row", async () => {
    const dana = addUser(db.raw, { email: "dana@acme.io" });
    const reg = await registerCompany(db.d1, { id: dana, email: "dana@acme.io" }, input());
    expect(reg).toMatchObject({ kind: "company", status: "active", domainVerified: true });

    const [co] = all(db.raw, "SELECT * FROM companies");
    expect(co).toMatchObject({
      id: reg.companyId,
      name: "Acme Labs",
      kind: "company",
      status: "active",
      website: "https://acme.io",
      domain: "acme.io",
      country: "FR",
      terms_version: COMPANY_TERMS_VERSION,
      created_by: dana,
    });
    expect(co.terms_accepted_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(co.domain_verified_at).not.toBeNull();
    expect(all(db.raw, "SELECT user_id, role FROM company_members")).toEqual([{ user_id: dana, role: "owner" }]);

    const [audit] = all<{ actor: string; action: string; meta_json: string }>(db.raw, "SELECT actor, action, meta_json FROM audit_log");
    expect(audit.actor).toBe(`${reg.companyId}:member:${dana}`);
    expect(audit.action).toBe("company.create");
    expect(JSON.parse(audit.meta_json)).toMatchObject({ company_id: reg.companyId, kind: "company", domain_verified: true });

    // Сесія людини тепер діє від імені компанії: власник, доступ за запит (без підписки).
    const ctx = await ownerCtx(dana);
    expect(ctx.actor).toMatchObject({ kind: "member", role: "owner", companyId: reg.companyId });
    expect(ctx.company).toMatchObject({ status: "active", access: "pay_per_request", domainVerified: true });
  });

  it("does not mark a gmail domain as verified", async () => {
    const dana = addUser(db.raw, { email: "dana@gmail.com" });
    const reg = await registerCompany(db.d1, { id: dana, email: "dana@gmail.com" }, input({ website: "https://gmail.com", domain: "gmail.com" }));
    expect(reg.domainVerified).toBe(false);
    expect(all(db.raw, "SELECT domain_verified_at FROM companies")).toEqual([{ domain_verified_at: null }]);

    // Пошта на gmail при сайті компанії теж нічого не доводить.
    const lee = addUser(db.raw, { email: "lee@gmail.com" });
    expect((await registerCompany(db.d1, { id: lee, email: "lee@gmail.com" }, input())).domainVerified).toBe(false);
    // Telegram без пошти: не перевірено.
    const tg = addUser(db.raw, { email: null, telegram: "tg_user" });
    expect((await registerCompany(db.d1, { id: tg, email: null }, input())).domainVerified).toBe(false);
  });

  it("verifies an owner email on a subdomain of the site", async () => {
    const dana = addUser(db.raw, { email: "dana@eng.acme.io" });
    expect((await registerCompany(db.d1, { id: dana, email: "dana@eng.acme.io" }, input())).domainVerified).toBe(true);
  });

  it(`allows ${COMPANIES_PER_DAY} new companies a day per person`, async () => {
    const dana = addUser(db.raw, { email: "dana@acme.io" });
    for (let i = 0; i < COMPANIES_PER_DAY; i++) await registerCompany(db.d1, { id: dana, email: "dana@acme.io" }, input());
    const err = await failure(registerCompany(db.d1, { id: dana, email: "dana@acme.io" }, input()));
    expect(err.code).toBe("too_many_companies");
    expect(all(db.raw, "SELECT COUNT(*) AS n FROM companies")).toEqual([{ n: COMPANIES_PER_DAY }]);
    expect(all(db.raw, "SELECT COUNT(*) AS n FROM company_members")).toEqual([{ n: COMPANIES_PER_DAY }]);
    expect(all(db.raw, "SELECT COUNT(*) AS n FROM audit_log")).toEqual([{ n: COMPANIES_PER_DAY }]);
  });
});

describe("registerCompany: recruiting agency", () => {
  it("waits for review: no CRM access, only settings", async () => {
    const ann = addUser(db.raw, { email: "ann@hire.co" });
    const reg = await registerCompany(db.d1, { id: ann, email: "ann@hire.co" }, input({ name: "Hire Co", kind: "agency", website: "https://hire.co", domain: "hire.co" }));
    expect(reg).toMatchObject({ kind: "agency", status: "pending_review" });

    const ctx = await ownerCtx(ann);
    expect(ctx.company).toMatchObject({ status: "pending_review", access: "none" });
    expect(await failure(runAction("search_candidates", { filters: {} }, ctx))).toMatchObject({
      code: "company_not_active",
      message: "Your application is under review. We review applications within 2 business days.",
    });
    // Налаштування працюють.
    const res = await updateCompanySettings(ctx, { ...input({ name: "Hire Co Ltd", website: "https://hire.co", domain: "hire.co" }), about: null, xHandle: null });
    expect(res.changed).toEqual(["name"]);
  });
});

describe("company switcher", () => {
  it("lists every company of the person, closed ones last; the cookie picks one only among them", async () => {
    const dana = addUser(db.raw, { email: "dana@acme.io" });
    const a = addCompany(db.raw, { name: "Acme" });
    const b = addCompany(db.raw, { name: "Beta" });
    const c = addCompany(db.raw, { name: "Closed Co", status: "closed" });
    const other = addCompany(db.raw, { name: "Not mine" });
    addMember(db.raw, a, dana, "owner");
    addMember(db.raw, b, dana, "member");
    addMember(db.raw, c, dana, "owner");
    run(db.raw, "UPDATE company_members SET last_seen_at = datetime('now') WHERE company_id = ?", c);

    const list = await listMemberships(db.d1, dana);
    expect(list.map((m) => m.name)).toEqual(["Acme", "Beta", "Closed Co"]);
    expect(list.find((m) => m.companyId === b)?.role).toBe("member");

    expect((await ownerCtx(dana, b)).company?.id).toBe(b);
    // Кукі чужої компанії нічого не дає: людина лишається у своїй.
    expect((await ownerCtx(dana, other)).company?.id).not.toBe(other);
  });
});

describe("settings", () => {
  let owner: string;
  let member: string;
  let co: string;
  beforeEach(async () => {
    owner = addUser(db.raw, { email: "dana@acme.io" });
    member = addUser(db.raw, { email: "lee@acme.io" });
    co = (await registerCompany(db.d1, { id: owner, email: "dana@acme.io" }, input())).companyId;
    addMember(db.raw, co, member, "member");
  });

  it("only the owner changes the profile; a member reads it", async () => {
    const parsed = parseSettings({ name: "Acme Labs", website: "acme.io", country: "FR", about: "We build lending.", x_handle: "@AcmeLabs" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(await failure(updateCompanySettings(await ownerCtx(member), parsed.value))).toMatchObject({ code: "forbidden", status: 403 });

    const res = await updateCompanySettings(await ownerCtx(owner), parsed.value);
    expect(res.changed.sort()).toEqual(["about", "x_handle"]);
    expect(await loadCompanyProfile(db.d1, co)).toMatchObject({ about: "We build lending.", xHandle: "acmelabs" });
    expect(all(db.raw, "SELECT action FROM audit_log ORDER BY id")).toEqual([{ action: "company.create" }, { action: "company.update" }]);
  });

  it("a new website domain is verified again by the email of the owner who saves it", async () => {
    const ctx = await ownerCtx(owner);
    const moved = await updateCompanySettings(ctx, { ...input({ website: "https://acme.xyz", domain: "acme.xyz" }), about: null, xHandle: null });
    expect(moved.domainVerified).toBe(false);
    expect((await loadCompanyProfile(db.d1, co))?.domainVerifiedAt).toBeNull();

    const back = await updateCompanySettings(ctx, { ...input(), about: null, xHandle: null });
    expect(back.domainVerified).toBe(true);
  });

  it("changes only the company of the session, never another tenant", async () => {
    const other = addCompany(db.raw, { name: "Other Co" });
    await updateCompanySettings(await ownerCtx(owner, other), { ...input({ name: "Renamed" }), about: null, xHandle: null });
    expect(all(db.raw, "SELECT name FROM companies WHERE id = ?", other)).toEqual([{ name: "Other Co" }]);
    expect(all(db.raw, "SELECT name FROM companies WHERE id = ?", co)).toEqual([{ name: "Renamed" }]);
  });
});

describe("close company", () => {
  it("cancels Stripe, revokes keys, withdraws pending intros and closes; the member cannot", async () => {
    const owner = addUser(db.raw, { email: "dana@acme.io" });
    const member = addUser(db.raw, { email: "lee@acme.io" });
    const cand = addUser(db.raw, { email: "cand@example.com" });
    const co = (await registerCompany(db.d1, { id: owner, email: "dana@acme.io" }, input())).companyId;
    addMember(db.raw, co, member, "member");
    addSubscription(db.raw, co, { provider: "stripe", status: "active" });
    const key = await addApiKey(db.raw, co);
    run(db.raw, "INSERT INTO pipeline (id, company_id, user_id, stage, added_via) VALUES (7, ?, ?, 'intro_requested', 'web')", co, cand);
    run(
      db.raw,
      `INSERT INTO intros (id, company_id, user_id, pipeline_id, mode, message, requested_via, respond_token_hash, expires_at)
       VALUES ('int_1', ?, ?, 7, 'approval', 'We would like to talk about a role.', 'web', 'tok', datetime('now', '+14 days'))`,
      co,
      cand,
    );

    expect(await failure(closeCompany(await ownerCtx(member), { stripe: null }))).toMatchObject({ code: "forbidden" });

    // Stripe відмовив: компанія лишається відкритою, щоб не брати гроші з закритої.
    const broken = { subscriptions: { cancel: vi.fn().mockRejectedValue(new Error("network")), retrieve: vi.fn() } };
    expect(await failure(closeCompany(await ownerCtx(owner), { stripe: broken }))).toMatchObject({ code: "stripe_failed" });
    expect(all(db.raw, "SELECT status FROM companies")).toEqual([{ status: "active" }]);

    const stripe = { subscriptions: { cancel: vi.fn().mockResolvedValue({}), retrieve: vi.fn() } };
    expect(await closeCompany(await ownerCtx(owner), { stripe })).toEqual({ canceledStripe: 1 });
    expect(stripe.subscriptions.cancel).toHaveBeenCalledTimes(1);
    expect(all(db.raw, "SELECT status FROM companies")).toEqual([{ status: "closed" }]);
    expect(all(db.raw, "SELECT status FROM subscriptions")).toEqual([{ status: "canceled" }]);
    expect(all(db.raw, "SELECT status, respond_token_hash FROM intros")).toEqual([{ status: "canceled", respond_token_hash: "tok" }]);
    expect(all(db.raw, "SELECT stage FROM pipeline")).toEqual([{ stage: "found" }]);
    expect(all(db.raw, "SELECT kind FROM pipeline_events")).toEqual([{ kind: "intro_canceled" }]);
    expect(all(db.raw, "SELECT action FROM audit_log ORDER BY id DESC LIMIT 1")).toEqual([{ action: "company.close" }]);

    // Ключ більше не працює; сесія бачить закриту компанію, дії реєстру закрито.
    expect(await failure(contextFor(db, { authorization: `Bearer ${key.key}` }))).toMatchObject({ code: "key_revoked" });
    const ctx = await ownerCtx(owner);
    expect(await failure(runAction("search_candidates", { filters: {} }, ctx))).toMatchObject({ code: "company_not_active" });
    expect(await failure(closeCompany(ctx, { stripe }))).toMatchObject({ code: "company_not_active" });
  });
});

describe("people labels and the activity log", () => {
  it("shows current members by email and everyone else as Former member", async () => {
    const owner = addUser(db.raw, { email: "dana@acme.io" });
    const gone = addUser(db.raw, { email: "gone@acme.io" });
    const co = (await registerCompany(db.d1, { id: owner, email: "dana@acme.io" }, input())).companyId;
    const labels = await memberLabels(db.d1, co, [owner, gone, "deleted-user"]);
    expect(Object.fromEntries(labels)).toEqual({ [owner]: "dana@acme.io", [gone]: FORMER_MEMBER, "deleted-user": FORMER_MEMBER });

    const cand = addUser(db.raw, { id: "3f9a1c00-0000-4000-8000-000000000000" });
    run(
      db.raw,
      `INSERT INTO audit_log (actor, action, target, meta_json, at) VALUES
         (?, 'pipeline.note', ?, '{}', datetime('now', '+1 minute')),
         ('other_co:member:x', 'pipeline.add', ?, '{}', datetime('now', '+2 minutes'))`,
      `${co}:member:${gone}`,
      cand,
      cand,
    );
    const rows = await listActivity(await ownerCtx(owner));
    // Лише своя компанія; про кандидата лише мітка.
    expect(rows.map((r) => [r.who, r.what])).toEqual([
      [FORMER_MEMBER, "added a note on #3F9A1C"],
      ["dana@acme.io", "created the company"],
    ]);
  });
});
