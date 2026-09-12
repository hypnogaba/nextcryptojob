import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "@/lib/auth/session";
import { harness, resetHarness } from "@/test/harness";
import {
  addApiKey,
  addCompany,
  addMember,
  addSubscription,
  addUser,
  all,
  contextFor,
  crmDb,
  run,
  TEST_ENV,
} from "@/test/crm-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { COMPANY_COOKIE, resolveWebActor } from "./context";
import { createApiKey, revokeApiKey } from "./keys";
import { ActionError } from "./types";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/navigation", async () => (await import("@/test/harness")).navigationModule);

let db: TestDb;
beforeEach(() => {
  db = crmDb();
});

async function rejection(p: Promise<unknown>): Promise<ActionError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ActionError) return e;
    throw e;
  }
  throw new Error("expected an ActionError");
}

describe("API key actor", () => {
  it("finds the company by the SHA-256 of the key and acts for it", async () => {
    const co = addCompany(db.raw, { name: "Acme Labs" });
    addSubscription(db.raw, co);
    const { id, key } = await addApiKey(db.raw, co, { name: "sourcing bot" });

    const ctx = await contextFor(db, { authorization: `Bearer ${key}` });
    expect(ctx.actor).toEqual({ kind: "agent", keyId: id, keyName: "sourcing bot", keyPrefix: key.slice(0, 16), companyId: co });
    expect(ctx.company).toMatchObject({ id: co, name: "Acme Labs", access: "subscription", plan: "subscription" });
    // Самого ключа в базі немає, лише хеш.
    expect(JSON.stringify(all(db.raw, "SELECT * FROM api_keys"))).not.toContain(key);
  });

  it("answers 401 key_revoked for a revoked key and invalid_api_key for an unknown or malformed one", async () => {
    const co = addCompany(db.raw);
    const revoked = await addApiKey(db.raw, co, { revoked: true });
    expect(await rejection(contextFor(db, { authorization: `Bearer ${revoked.key}` }))).toMatchObject({
      code: "key_revoked",
      status: 401,
    });
    const unknown = `ncj_live_${"A".repeat(43)}`;
    expect(await rejection(contextFor(db, { authorization: `Bearer ${unknown}` }))).toMatchObject({
      code: "invalid_api_key",
      status: 401,
    });
    expect(await rejection(contextFor(db, { authorization: "Bearer nope" }))).toMatchObject({ code: "invalid_api_key" });
    expect(await rejection(contextFor(db, { authorization: "Basic abc" }))).toMatchObject({ code: "invalid_api_key" });
  });

  it("a key revoked by the owner stops working on the next request", async () => {
    const owner = addUser(db.raw, { visible: false });
    const co = addCompany(db.raw);
    addMember(db.raw, co, owner, "owner");
    const { id, key } = await addApiKey(db.raw, co);
    await contextFor(db, { authorization: `Bearer ${key}` });

    await revokeApiKey(await contextFor(db, { sessionUserId: owner, channel: "web" }), id);
    expect(await rejection(contextFor(db, { authorization: `Bearer ${key}` }))).toMatchObject({ code: "key_revoked" });
  });

  it("writes last_used_at at most once per 5 minutes", async () => {
    const co = addCompany(db.raw);
    const { id, key } = await addApiKey(db.raw, co);
    await contextFor(db, { authorization: `Bearer ${key}` });
    const [first] = all<{ last_used_at: string }>(db.raw, "SELECT last_used_at FROM api_keys WHERE id = ?", id);
    expect(first.last_used_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    run(db.raw, "UPDATE api_keys SET last_used_at = datetime('now', '-4 minutes') WHERE id = ?", id);
    const [held] = all<{ last_used_at: string }>(db.raw, "SELECT last_used_at FROM api_keys WHERE id = ?", id);
    await contextFor(db, { authorization: `Bearer ${key}` });
    expect(all(db.raw, "SELECT last_used_at FROM api_keys WHERE id = ?", id)[0]).toEqual(held);

    run(db.raw, "UPDATE api_keys SET last_used_at = datetime('now', '-6 minutes') WHERE id = ?", id);
    await contextFor(db, { authorization: `Bearer ${key}` });
    expect(all<{ last_used_at: string }>(db.raw, "SELECT last_used_at FROM api_keys WHERE id = ?", id)[0].last_used_at).not.toBe(
      held.last_used_at,
    );
  });

  it("the key wins over a session and over a payment", async () => {
    const co = addCompany(db.raw);
    const { key } = await addApiKey(db.raw, co);
    const someone = addUser(db.raw, { visible: false });
    const ctx = await contextFor(db, { authorization: `Bearer ${key}`, sessionUserId: someone, hasPayment: true });
    expect(ctx.actor.kind).toBe("agent");
  });
});

describe("session actor", () => {
  it("a signed-in member acts for their company with their role", async () => {
    const user = addUser(db.raw, { visible: false });
    const co = addCompany(db.raw);
    addMember(db.raw, co, user, "member");
    const ctx = await contextFor(db, { sessionUserId: user, channel: "web" });
    expect(ctx.actor).toEqual({ kind: "member", role: "member", userId: user, companyId: co });
    expect(ctx.company?.plan).toBe("pay_per_request");
  });

  it("prefers the company from the ncj_company cookie when the person is in several", async () => {
    const user = addUser(db.raw, { visible: false });
    const a = addCompany(db.raw, { name: "A" });
    const b = addCompany(db.raw, { name: "B" });
    addMember(db.raw, a, user, "owner");
    addMember(db.raw, b, user, "member");
    expect((await contextFor(db, { sessionUserId: user, companyId: b })).actor).toMatchObject({ companyId: b, role: "member" });
    expect((await contextFor(db, { sessionUserId: user, companyId: a })).actor).toMatchObject({ companyId: a, role: "owner" });
    // Чужа компанія в кукі нічого не дає: беремо свою.
    const other = addCompany(db.raw);
    expect([a, b]).toContain(((await contextFor(db, { sessionUserId: user, companyId: other })).actor as { companyId: string }).companyId);
  });

  it("a signed-in person without a company gets 401, a pending invite is not membership", async () => {
    const user = addUser(db.raw, { visible: false, email: "invitee@example.com" });
    const co = addCompany(db.raw);
    run(db.raw, "INSERT INTO company_members (company_id, invite_email, role) VALUES (?, 'invitee@example.com', 'member')", co);
    expect(await rejection(contextFor(db, { sessionUserId: user }))).toMatchObject({ code: "unauthorized", status: 401 });
  });

  it("reads the session cookie and the company cookie in server actions", async () => {
    resetHarness();
    harness.env = { ...harness.env, DB: db.d1 };
    harness.raw = db.raw;
    const user = addUser(db.raw, { visible: false });
    const a = addCompany(db.raw);
    const b = addCompany(db.raw);
    addMember(db.raw, a, user, "owner");
    addMember(db.raw, b, user, "member");
    await createSession(user);
    harness.jar.set(COMPANY_COOKIE, b);
    const ctx = await resolveWebActor();
    expect(ctx.channel).toBe("web");
    expect(ctx.env.SESSION_SECRET).toBe(harness.env.SESSION_SECRET);
    expect((await resolveWebActor({ db: db.d1, env: TEST_ENV })).actor).toEqual(ctx.actor);
    expect(ctx.actor).toMatchObject({ kind: "member", companyId: b, role: "member" });
  });
});

describe("x402 guest and no credentials", () => {
  it("a request with only a payment is a guest without a company", async () => {
    const ctx = await contextFor(db, { hasPayment: true });
    expect(ctx.actor).toEqual({ kind: "x402_guest", payer: null, paymentId: null });
    expect(ctx.company).toBeNull();
  });

  it("nothing at all is 401 unauthorized", async () => {
    expect(await rejection(contextFor(db, {}))).toMatchObject({ code: "unauthorized", status: 401 });
  });
});

describe("company plan", () => {
  it("tells a trial from a paid subscription, and none for a suspended company", async () => {
    const trial = addCompany(db.raw);
    addSubscription(db.raw, trial, { status: "trialing", provider: "stripe" });
    const paid = addCompany(db.raw);
    addSubscription(db.raw, paid, { status: "trialing", provider: "stripe" });
    addSubscription(db.raw, paid, { status: "active", provider: "usdc" });
    const suspended = addCompany(db.raw, { status: "suspended" });

    const plan = async (co: string) => {
      const { key } = await addApiKey(db.raw, co);
      return (await contextFor(db, { authorization: `Bearer ${key}` })).company?.plan;
    };
    expect(await plan(trial)).toBe("trial");
    expect(await plan(paid)).toBe("subscription");
    expect(await plan(suspended)).toBe("none");
  });
});

describe("API keys", () => {
  async function ownerAndMember() {
    const owner = addUser(db.raw, { visible: false });
    const member = addUser(db.raw, { visible: false });
    const co = addCompany(db.raw);
    addSubscription(db.raw, co);
    addMember(db.raw, co, owner, "owner");
    addMember(db.raw, co, member, "member");
    return { co, owner, member };
  }

  it("a member cannot create a key; nothing is written", async () => {
    const { member } = await ownerAndMember();
    const ctx = await contextFor(db, { sessionUserId: member, channel: "web" });
    expect(await rejection(createApiKey(ctx, "bot"))).toMatchObject({ code: "forbidden", status: 403 });
    expect(all(db.raw, "SELECT id FROM api_keys")).toEqual([]);
  });

  it("an agent cannot mint keys either", async () => {
    const { co } = await ownerAndMember();
    const { key } = await addApiKey(db.raw, co);
    const ctx = await contextFor(db, { authorization: `Bearer ${key}` });
    expect(await rejection(createApiKey(ctx, "child"))).toMatchObject({ code: "forbidden" });
  });

  it("the owner gets a key once; it resolves to the company and is stored only as a hash", async () => {
    const { co, owner } = await ownerAndMember();
    const created = await createApiKey(await contextFor(db, { sessionUserId: owner, channel: "web" }), " CI bot ");
    expect(created.key).toMatch(/^ncj_live_[A-Za-z0-9]{43}$/);
    expect(created).toMatchObject({ name: "CI bot", prefix: created.key.slice(0, 16) });
    expect(JSON.stringify(all(db.raw, "SELECT * FROM api_keys"))).not.toContain(created.key);
    const ctx = await contextFor(db, { authorization: `Bearer ${created.key}` });
    expect(ctx.actor).toMatchObject({ kind: "agent", keyId: created.key_id, companyId: co });
    expect(all(db.raw, "SELECT action FROM audit_log")).toEqual([{ action: "api_key.create" }]);
  });

  it("keeps to the key limit of the plan (2 in a trial)", async () => {
    const owner = addUser(db.raw, { visible: false });
    const co = addCompany(db.raw);
    addSubscription(db.raw, co, { status: "trialing", provider: "stripe" });
    addMember(db.raw, co, owner, "owner");
    const ctx = await contextFor(db, { sessionUserId: owner, channel: "web" });
    await createApiKey(ctx, "one");
    const two = await createApiKey(ctx, "two");
    expect(await rejection(createApiKey(ctx, "three"))).toMatchObject({ code: "quota_exceeded", status: 403 });
    await revokeApiKey(ctx, two.key_id);
    await expect(createApiKey(ctx, "three")).resolves.toMatchObject({ name: "three" });
  });

  it("an owner cannot revoke another company's key", async () => {
    const { owner } = await ownerAndMember();
    const other = addCompany(db.raw);
    const foreign = await addApiKey(db.raw, other);
    const ctx = await contextFor(db, { sessionUserId: owner, channel: "web" });
    expect(await rejection(revokeApiKey(ctx, foreign.id))).toMatchObject({ code: "not_found", status: 404 });
    await expect(contextFor(db, { authorization: `Bearer ${foreign.key}` })).resolves.toBeTruthy();
  });
});
