import { beforeEach, describe, expect, it } from "vitest";
import type { Mailer, MailMessage } from "@/lib/mail";
import { addCompany, addMember, addSubscription, addUser, all, contextFor, crmDb, run } from "@/test/crm-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { CompanyError, FORMER_MEMBER, LAST_OWNER_TEXT, memberLabels, registerCompany } from "./company";
import { acceptInvite, changeRole, findInvite, INVITE_DAYS, inviteMember, leaveCompany, loadTeam, removeMember, revokeInvite } from "./team";
import { ActionError } from "./types";

let db: TestDb;
beforeEach(() => {
  db = crmDb();
});

const ORIGIN = "https://nextcryptojob.xyz";
const DAY = 86_400_000;

async function failure(p: Promise<unknown>): Promise<ActionError | CompanyError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ActionError || e instanceof CompanyError) return e;
    throw e;
  }
  throw new Error("expected an error");
}

function fakeMailer(): Mailer & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return { sent, send: async (m) => void sent.push(m) };
}

const ctxOf = (userId: string, companyId?: string, now?: Date) =>
  contextFor(db, { sessionUserId: userId, companyId: companyId ?? null }, { now });

/** Токен з посилання, яке показали власнику (пошти немає). */
function tokenOf(link: string | null): string {
  expect(link).toMatch(/^https:\/\/nextcryptojob\.xyz\/company\/join\?t=[A-Za-z0-9_-]{43}$/);
  return new URL(link!).searchParams.get("t")!;
}

async function companyWithOwner(o: { subscription?: boolean } = {}) {
  const owner = addUser(db.raw, { email: "dana@acme.io" });
  const { companyId } = await registerCompany(db.d1, { id: owner, email: "dana@acme.io" }, {
    name: "Acme Labs",
    website: "https://acme.io",
    domain: "acme.io",
    country: "FR",
    kind: "company",
  });
  if (o.subscription) addSubscription(db.raw, companyId);
  return { owner, companyId };
}

async function invite(owner: string, email: string, now?: Date): Promise<string> {
  const res = await inviteMember(await ctxOf(owner, undefined, now), email, { origin: ORIGIN, mailer: null });
  return tokenOf(res.link);
}

describe("a test company with two people", () => {
  it("the owner invites a teammate by email, the teammate accepts and both are on the team", async () => {
    const { owner, companyId } = await companyWithOwner();
    const mailer = fakeMailer();
    const res = await inviteMember(await ctxOf(owner), " Lee@Acme.io ", { origin: ORIGIN, mailer });
    expect(res).toMatchObject({ email: "lee@acme.io", emailed: true, link: null });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({ to: "lee@acme.io", subject: "dana@acme.io invited you to Acme Labs on NextCryptoJob" });
    const token = new URL(/https:\/\/\S+join\?t=\S+/.exec(mailer.sent[0].text)![0]).searchParams.get("t")!;

    // У базі лише хеш токена, пошти в журналі немає.
    expect(JSON.stringify(all(db.raw, "SELECT * FROM company_members"))).not.toContain(token);
    expect(JSON.stringify(all(db.raw, "SELECT * FROM audit_log"))).not.toContain("lee@acme.io");

    const lee = addUser(db.raw, { email: "lee@acme.io" });
    expect(await acceptInvite(db.d1, { id: lee, email: "lee@acme.io" }, token)).toMatchObject({
      companyId,
      companyName: "Acme Labs",
      alreadyMember: false,
    });

    const team = await loadTeam(await ctxOf(owner));
    expect(team.members.map((m) => [m.label, m.role])).toEqual([
      ["dana@acme.io", "owner"],
      ["lee@acme.io", "member"],
    ]);
    expect(team.invites).toEqual([]);
    expect(team.seats).toEqual({ used: 2, limit: 2 });

    const leeCtx = await ctxOf(lee);
    expect(leeCtx.actor).toMatchObject({ kind: "member", role: "member", companyId });
    expect(all(db.raw, "SELECT actor, action FROM audit_log ORDER BY id")).toEqual([
      { actor: `${companyId}:member:${owner}`, action: "company.create" },
      { actor: `${companyId}:member:${owner}`, action: "team.invite" },
      { actor: `${companyId}:member:${lee}`, action: "team.join" },
    ]);
  });

  it("shows the owner the link to copy when mail is not available or fails", async () => {
    const { owner } = await companyWithOwner();
    const none = await inviteMember(await ctxOf(owner), "lee@acme.io", { origin: ORIGIN, mailer: null });
    expect(none.emailed).toBe(false);
    tokenOf(none.link);

    const failing: Mailer = { send: async () => Promise.reject(new Error("E_SENDER_NOT_VERIFIED")) };
    const res = await inviteMember(await ctxOf(owner), "lee@acme.io", { origin: ORIGIN, mailer: failing });
    expect(res.emailed).toBe(false);
    // Нове запрошення тієї самої пошти замінює старе: старе посилання більше не діє.
    expect((await findInvite(db.d1, tokenOf(none.link))).state).toBe("invalid");
    expect((await findInvite(db.d1, tokenOf(res.link))).state).toBe("valid");
  });

  it("members see the team but cannot invite", async () => {
    const { owner, companyId } = await companyWithOwner();
    const lee = addUser(db.raw, { email: "lee@acme.io" });
    addMember(db.raw, companyId, lee, "member");
    expect((await loadTeam(await ctxOf(lee))).members).toHaveLength(2);
    expect(await failure(inviteMember(await ctxOf(lee), "x@acme.io", { origin: ORIGIN, mailer: null }))).toMatchObject({
      code: "forbidden",
      message: "Only the company owner can manage the team.",
    });
    void owner;
  });
});

describe("accepting an invite", () => {
  it("only the signed-in person whose verified email is the invited one can accept", async () => {
    const { owner } = await companyWithOwner();
    const token = await invite(owner, "lee@acme.io");

    const eve = addUser(db.raw, { email: "eve@acme.io" });
    expect(await failure(acceptInvite(db.d1, { id: eve, email: "eve@acme.io" }, token))).toMatchObject({
      code: "invite_email_mismatch",
      message: "This invite was sent to l***@acme.io. Sign out and sign in with that email to accept it.",
    });
    const tg = addUser(db.raw, { email: null, telegram: "lee_tg" });
    expect(await failure(acceptInvite(db.d1, { id: tg, email: null }, token))).toMatchObject({ code: "email_required" });
    expect(all(db.raw, "SELECT COUNT(*) AS n FROM company_members WHERE user_id IS NOT NULL")).toEqual([{ n: 1 }]);

    const lee = addUser(db.raw, { email: "lee@acme.io" });
    await acceptInvite(db.d1, { id: lee, email: "LEE@acme.io" }, token);
    expect(all(db.raw, "SELECT COUNT(*) AS n FROM company_members WHERE user_id IS NOT NULL")).toEqual([{ n: 2 }]);
  });

  it(`expires after ${INVITE_DAYS} days`, async () => {
    const { owner } = await companyWithOwner();
    const sent = new Date("2026-09-12T10:00:00Z");
    const token = await invite(owner, "lee@acme.io", sent);
    const lee = addUser(db.raw, { email: "lee@acme.io" });

    const late = new Date(sent.getTime() + INVITE_DAYS * DAY + 1000);
    expect(await findInvite(db.d1, token, late)).toEqual({ state: "expired", companyName: "Acme Labs" });
    expect(await failure(acceptInvite(db.d1, { id: lee, email: "lee@acme.io" }, token, late))).toMatchObject({
      code: "invite_expired",
    });

    const inTime = new Date(sent.getTime() + INVITE_DAYS * DAY - 60_000);
    expect((await acceptInvite(db.d1, { id: lee, email: "lee@acme.io" }, token, inTime)).alreadyMember).toBe(false);
  });

  it("works once: the same link cannot add anyone again", async () => {
    const { owner } = await companyWithOwner({ subscription: true });
    const token = await invite(owner, "lee@acme.io");
    const lee = addUser(db.raw, { email: "lee@acme.io" });
    await acceptInvite(db.d1, { id: lee, email: "lee@acme.io" }, token);

    expect(await findInvite(db.d1, token)).toEqual({ state: "invalid" });
    expect(await failure(acceptInvite(db.d1, { id: lee, email: "lee@acme.io" }, token))).toMatchObject({ code: "invite_invalid" });
    expect(all(db.raw, "SELECT invite_token_hash FROM company_members WHERE user_id = ?", lee)).toEqual([{ invite_token_hash: null }]);
    expect(await failure(acceptInvite(db.d1, { id: lee, email: "lee@acme.io" }, "not-a-token"))).toMatchObject({ code: "invite_invalid" });
  });

  it("a canceled invite link stops working", async () => {
    const { owner } = await companyWithOwner();
    const token = await invite(owner, "lee@acme.io");
    const [{ id }] = all<{ id: number }>(db.raw, "SELECT id FROM company_members WHERE user_id IS NULL");
    await revokeInvite(await ctxOf(owner), id);
    expect((await findInvite(db.d1, token)).state).toBe("invalid");
    expect(all(db.raw, "SELECT action FROM audit_log ORDER BY id DESC LIMIT 1")).toEqual([{ action: "team.invite_revoke" }]);
  });
});

describe("seats", () => {
  it("a subscribed company has at most 5 people, pending invites included", async () => {
    const { owner } = await companyWithOwner({ subscription: true });
    const tokens: string[] = [];
    for (const n of [1, 2, 3, 4]) tokens.push(await invite(owner, `p${n}@acme.io`));
    expect(await failure(inviteMember(await ctxOf(owner), "p5@acme.io", { origin: ORIGIN, mailer: null }))).toMatchObject({
      code: "seat_limit",
    });
    // Той, хто вже запрошений, може отримати нове посилання: місце його.
    await invite(owner, "p4@acme.io");

    for (const [i, n] of [1, 2, 3].entries()) {
      const id = addUser(db.raw, { email: `p${n}@acme.io` });
      await acceptInvite(db.d1, { id, email: `p${n}@acme.io` }, tokens[i]);
    }
    const team = await loadTeam(await ctxOf(owner));
    expect(team.seats).toEqual({ used: 5, limit: 5 });
  });

  it("without a subscription the team has 2 people; expired invites free their seat", async () => {
    const { owner } = await companyWithOwner();
    const sent = new Date(Date.now() - (INVITE_DAYS + 1) * DAY);
    await invite(owner, "old@acme.io", sent);
    await invite(owner, "lee@acme.io");
    expect(await failure(inviteMember(await ctxOf(owner), "kim@acme.io", { origin: ORIGIN, mailer: null }))).toMatchObject({
      code: "seat_limit",
      message: "Your plan allows 2 people on the team, pending invites included. Remove someone or cancel an invite first.",
    });
  });

  it("an invite cannot be accepted into a full team", async () => {
    const { owner, companyId } = await companyWithOwner();
    const token = await invite(owner, "lee@acme.io");
    // Місце зайняли інакше (напр. план зменшився після запрошення).
    addMember(db.raw, companyId, addUser(db.raw, { email: "kim@acme.io" }), "member");
    const lee = addUser(db.raw, { email: "lee@acme.io" });
    expect(await failure(acceptInvite(db.d1, { id: lee, email: "lee@acme.io" }, token))).toMatchObject({ code: "seat_limit" });
    expect(all(db.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'team.join'")).toEqual([{ n: 0 }]);
  });
});

describe("roles and the last owner", () => {
  let owner: string;
  let lee: string;
  let companyId: string;
  beforeEach(async () => {
    ({ owner, companyId } = await companyWithOwner({ subscription: true }));
    lee = addUser(db.raw, { email: "lee@acme.io" });
    addMember(db.raw, companyId, lee, "member");
  });

  it("the owner makes a member an owner and back; a member cannot change roles", async () => {
    expect(await failure(changeRole(await ctxOf(lee), owner, "member"))).toMatchObject({ code: "forbidden" });
    await changeRole(await ctxOf(owner), lee, "owner");
    expect((await ctxOf(lee)).actor).toMatchObject({ role: "owner" });
    await changeRole(await ctxOf(owner), lee, "member");
    expect((await ctxOf(lee)).actor).toMatchObject({ role: "member" });
    expect(all(db.raw, "SELECT action, meta_json FROM audit_log WHERE action = 'team.role'").map((r) => JSON.parse(String(r.meta_json)).role)).toEqual([
      "owner",
      "member",
    ]);
  });

  it("the only owner cannot leave, become a member or be removed", async () => {
    const ctx = await ctxOf(owner);
    expect(await failure(leaveCompany(ctx))).toMatchObject({ code: "last_owner", message: LAST_OWNER_TEXT });
    expect(await failure(changeRole(ctx, owner, "member"))).toMatchObject({ code: "last_owner", message: LAST_OWNER_TEXT });
    expect(await failure(removeMember(ctx, owner))).toMatchObject({ code: "validation_failed" });
    expect(all(db.raw, "SELECT role FROM company_members WHERE user_id = ?", owner)).toEqual([{ role: "owner" }]);
    expect(all(db.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('team.leave', 'team.role')")).toEqual([{ n: 0 }]);
  });

  it("with a second owner the first can step down or leave, and the second is then the last one", async () => {
    await changeRole(await ctxOf(owner), lee, "owner");
    await changeRole(await ctxOf(owner), owner, "member");
    expect(await failure(leaveCompany(await ctxOf(lee)))).toMatchObject({ code: "last_owner" });
    await leaveCompany(await ctxOf(owner));
    expect(all(db.raw, "SELECT user_id, role FROM company_members")).toEqual([{ user_id: lee, role: "owner" }]);
    expect(all(db.raw, "SELECT actor, action FROM audit_log ORDER BY id DESC LIMIT 1")).toEqual([
      { actor: `${companyId}:member:${owner}`, action: "team.leave" },
    ]);
  });

  it("an owner can remove another owner while one owner stays", async () => {
    await changeRole(await ctxOf(owner), lee, "owner");
    await removeMember(await ctxOf(lee), owner);
    expect(all(db.raw, "SELECT user_id FROM company_members")).toEqual([{ user_id: lee }]);
  });

  it("a member can leave", async () => {
    await leaveCompany(await ctxOf(lee));
    expect(await failure(ctxOf(lee))).toMatchObject({ code: "unauthorized", status: 401 });
  });
});

describe("a removed member", () => {
  it("loses access on the next request; their notes stay, signed Former member", async () => {
    const { owner, companyId } = await companyWithOwner();
    const lee = addUser(db.raw, { email: "lee@acme.io" });
    addMember(db.raw, companyId, lee, "member");
    const cand = addUser(db.raw, { email: "cand@example.com" });
    run(db.raw, "INSERT INTO pipeline (id, company_id, user_id, added_via, added_by_user_id) VALUES (1, ?, ?, 'web', ?)", companyId, cand, lee);
    run(
      db.raw,
      `INSERT INTO pipeline_events (pipeline_id, company_id, kind, body, actor_kind, actor_user_id)
       VALUES (1, ?, 'note', 'Strong audits.', 'member', ?)`,
      companyId,
      lee,
    );

    const before = await ctxOf(lee, companyId);
    expect(before.company?.id).toBe(companyId);
    await removeMember(await ctxOf(owner), lee);

    expect(await failure(ctxOf(lee, companyId))).toMatchObject({ code: "unauthorized", status: 401 });
    expect(all(db.raw, "SELECT body, actor_user_id FROM pipeline_events")).toEqual([{ body: "Strong audits.", actor_user_id: lee }]);
    expect((await memberLabels(db.d1, companyId, [lee])).get(lee)).toBe(FORMER_MEMBER);
    expect(JSON.parse(String(all(db.raw, "SELECT meta_json FROM audit_log WHERE action = 'team.remove'")[0].meta_json))).toMatchObject({
      member_user_id: lee,
    });
  });
});

describe("tenant isolation", () => {
  it("an owner cannot see or touch people and invites of another company", async () => {
    const { owner } = await companyWithOwner({ subscription: true });
    const other = addCompany(db.raw, { name: "Other Co" });
    const bob = addUser(db.raw, { email: "bob@other.co" });
    addMember(db.raw, other, bob, "owner");
    const otherMember = addUser(db.raw, { email: "kim@other.co" });
    addMember(db.raw, other, otherMember, "member");
    addSubscription(db.raw, other);
    const otherToken = await invite(bob, "zed@other.co");
    const [{ id: otherInvite }] = all<{ id: number }>(db.raw, "SELECT id FROM company_members WHERE user_id IS NULL");

    // Навіть з кукі чужої компанії власник діє лише у своїй.
    const ctx = await ctxOf(owner, other);
    expect((await loadTeam(ctx)).members.map((m) => m.label)).toEqual(["dana@acme.io"]);
    expect(await failure(removeMember(ctx, otherMember))).toMatchObject({ code: "not_found" });
    expect(await failure(changeRole(ctx, otherMember, "owner"))).toMatchObject({ code: "not_found" });
    expect(await failure(revokeInvite(ctx, otherInvite))).toMatchObject({ code: "not_found" });
    expect((await findInvite(db.d1, otherToken)).state).toBe("valid");
    expect(all(db.raw, "SELECT COUNT(*) AS n FROM company_members WHERE company_id = ?", other)).toEqual([{ n: 3 }]);
  });
});

/** D1, у якого перед пакетом встигає відбутись чужа зміна (друга вкладка, інший власник). */
function racing(d1: D1Database, meanwhile: () => void): D1Database {
  return new Proxy(d1, {
    get(target, prop, receiver) {
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          meanwhile();
          return target.batch(statements);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

describe("races: the error says what happened and the log has one row per change", () => {
  it("an invite canceled while it is being accepted says it is not valid, not that the team is full", async () => {
    const { owner } = await companyWithOwner({ subscription: true });
    const token = await invite(owner, "lee@acme.io");
    const lee = addUser(db.raw, { email: "lee@acme.io" });
    const d1 = racing(db.d1, () => run(db.raw, "DELETE FROM company_members WHERE user_id IS NULL"));
    expect(await failure(acceptInvite(d1, { id: lee, email: "lee@acme.io" }, token))).toMatchObject({ code: "invite_invalid" });
    expect(all(db.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'team.join'")).toEqual([{ n: 0 }]);
  });

  it("an invite that expires between the check and the write says it expired", async () => {
    const { owner } = await companyWithOwner({ subscription: true });
    const token = await invite(owner, "lee@acme.io");
    const lee = addUser(db.raw, { email: "lee@acme.io" });
    const d1 = racing(db.d1, () => run(db.raw, "UPDATE company_members SET invited_at = datetime('now', '-8 days') WHERE user_id IS NULL"));
    expect(await failure(acceptInvite(d1, { id: lee, email: "lee@acme.io" }, token))).toMatchObject({ code: "invite_expired" });
  });

  it("removing someone another owner just removed says not on the team, not last owner", async () => {
    const { owner, companyId } = await companyWithOwner({ subscription: true });
    const lee = addUser(db.raw, { email: "lee@acme.io" });
    addMember(db.raw, companyId, lee, "member");
    const ctx = await ctxOf(owner);
    ctx.db = racing(db.d1, () => run(db.raw, "DELETE FROM company_members WHERE user_id = ?", lee));
    expect(await failure(removeMember(ctx, lee))).toMatchObject({ code: "not_found", message: "This person is not on your team." });
    expect(all(db.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'team.remove'")).toEqual([{ n: 0 }]);
  });

  it("a role change that another tab already made is fine and logged once", async () => {
    const { owner, companyId } = await companyWithOwner({ subscription: true });
    const lee = addUser(db.raw, { email: "lee@acme.io" });
    addMember(db.raw, companyId, lee, "member");
    await changeRole(await ctxOf(owner), lee, "owner");
    const ctx = await ctxOf(owner);
    run(db.raw, "UPDATE company_members SET role = 'member' WHERE user_id = ?", lee);
    ctx.db = racing(db.d1, () => run(db.raw, "UPDATE company_members SET role = 'owner' WHERE user_id = ?", lee));
    await changeRole(ctx, lee, "owner");
    expect(all(db.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'team.role'")).toEqual([{ n: 1 }]);
  });

  it("canceling the same invite twice: the second says it is gone, one log row", async () => {
    const { owner } = await companyWithOwner();
    await invite(owner, "lee@acme.io");
    const [{ id }] = all<{ id: number }>(db.raw, "SELECT id FROM company_members WHERE user_id IS NULL");
    await revokeInvite(await ctxOf(owner), id);
    expect(await failure(revokeInvite(await ctxOf(owner), id))).toMatchObject({ code: "not_found" });
    expect(all(db.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'team.invite_revoke'")).toEqual([{ n: 1 }]);
  });
});
