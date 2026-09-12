import { beforeEach, describe, expect, it } from "vitest";
import {
  addApiKey,
  addCompany,
  addMember,
  addPayment,
  addSubscription,
  addUsage,
  addUser,
  all,
  contextFor,
  crmDb,
} from "@/test/crm-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { PaymentRequired, runAction } from "./actions";
import type { ActionContext } from "./context";
import { checkBurst, monthWindow, reserveUsage } from "./quotas";
import { ActionError } from "./types";

let db: TestDb;
beforeEach(() => {
  db = crmDb();
});

async function agent(o: { status?: string; provider?: "manual" | "stripe" | "usdc"; subscribed?: boolean; now?: Date } = {}) {
  const co = addCompany(db.raw);
  if (o.subscribed !== false) addSubscription(db.raw, co, { status: o.status ?? "active", provider: o.provider });
  const { key } = await addApiKey(db.raw, co);
  return { co, ctx: await contextFor(db, { authorization: `Bearer ${key}` }, { now: o.now }) };
}

async function rejection(p: Promise<unknown>): Promise<ActionError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ActionError) return e;
    throw e;
  }
  throw new Error("expected an ActionError");
}

const NOON = new Date("2026-09-12T12:00:00Z");

describe("daily search quota", () => {
  it("the 300th search of the UTC day passes, the 301st gets 429 with RateLimit-* and Retry-After", async () => {
    const { co, ctx } = await agent({ now: NOON });
    addUsage(db.raw, 299, { companyId: co, action: "search_candidates", at: "2026-09-12 08:00:00" });

    const ok = await runAction("search_candidates", {}, ctx);
    expect(ok.status).toBe(200);
    expect(ok.headers).toEqual({ "RateLimit-Limit": "300", "RateLimit-Remaining": "0", "RateLimit-Reset": String(12 * 3600) });

    const err = await rejection(runAction("search_candidates", {}, ctx));
    expect(err).toMatchObject({ code: "daily_quota_exceeded", status: 429, message: "Daily search limit reached. It resets at 00:00 UTC." });
    expect(err.headers).toEqual({
      "RateLimit-Limit": "300",
      "RateLimit-Remaining": "0",
      "RateLimit-Reset": String(12 * 3600),
      "Retry-After": String(12 * 3600),
    });
    // Відмова не пише рядка обліку: рахуються лише успішні виклики.
    expect(all(db.raw, "SELECT COUNT(*) AS n FROM usage_events WHERE company_id = ?", co)).toEqual([{ n: 300 }]);
  });

  it("resets at 00:00 UTC: yesterday's calls do not count today", async () => {
    const late = new Date("2026-09-12T23:59:59Z");
    const { co, ctx } = await agent({ now: late });
    addUsage(db.raw, 300, { companyId: co, action: "search_candidates", at: "2026-09-12 00:00:00" });
    addUsage(db.raw, 50, { companyId: co, action: "search_candidates", at: "2026-09-11 23:59:59" });

    const err = await rejection(runAction("search_candidates", {}, ctx));
    expect(err.headers?.["RateLimit-Reset"]).toBe("1");

    const nextDay = { ...ctx, now: new Date("2026-09-13T00:00:00Z") } satisfies ActionContext;
    const ok = await runAction("search_candidates", {}, nextDay);
    expect(ok.headers["RateLimit-Remaining"]).toBe("299");
    expect(ok.headers["RateLimit-Reset"]).toBe(String(24 * 3600));
  });

  it("failed calls do not use the quota", async () => {
    const { co, ctx } = await agent({ now: NOON });
    addUsage(db.raw, 300, { companyId: co, action: "search_candidates", at: "2026-09-12 08:00:00", status: 500 });
    addUsage(db.raw, 10, { companyId: co, action: "search_candidates", at: "2026-09-12 08:00:00", status: 402 });
    const ok = await runAction("search_candidates", {}, ctx);
    expect(ok.headers["RateLimit-Remaining"]).toBe("299");
  });

  it("a handler failure gives the reserved call back", async () => {
    const { co, ctx } = await agent({ now: NOON });
    // Без SESSION_SECRET пошук відмовляє з 503 not_configured уже після броні.
    const broken = { ...ctx, env: {} };
    expect(await rejection(runAction("search_candidates", {}, broken))).toMatchObject({ code: "not_configured", status: 503 });
    expect(all(db.raw, "SELECT status FROM usage_events WHERE company_id = ?", co)).toEqual([{ status: 503 }]);
    const ok = await runAction("search_candidates", {}, ctx);
    expect(ok.headers["RateLimit-Remaining"]).toBe("299");
  });

  it("a trial has 50 searches a day, and other companies' calls never count", async () => {
    const { co, ctx } = await agent({ status: "trialing", provider: "stripe", now: NOON });
    const other = addCompany(db.raw);
    addUsage(db.raw, 500, { companyId: other, action: "search_candidates", at: "2026-09-12 08:00:00" });
    addUsage(db.raw, 49, { companyId: co, action: "search_candidates", at: "2026-09-12 08:00:00" });
    const ok = await runAction("search_candidates", {}, ctx);
    expect(ok.headers["RateLimit-Limit"]).toBe("50");
    expect(await rejection(runAction("search_candidates", {}, ctx))).toMatchObject({ code: "daily_quota_exceeded" });
  });
});

describe("pay per request and x402 guests", () => {
  it("a company without a subscription must pay for a search through the API", async () => {
    const { ctx } = await agent({ subscribed: false, now: NOON });
    await expect(runAction("search_candidates", {}, ctx)).rejects.toBeInstanceOf(PaymentRequired);
    const paid = await runAction("search_candidates", {}, ctx, { payment: { id: addPayment(db.raw), payer: "0xabc" } });
    expect(paid.headers["RateLimit-Limit"]).toBe("200");
    expect(all(db.raw, "SELECT billing FROM usage_events")).toEqual([{ billing: "x402" }]);
  });

  it("the web app cannot pay per request: a member without a subscription gets subscription_required", async () => {
    const user = addUser(db.raw, { visible: false });
    const co = addCompany(db.raw);
    addMember(db.raw, co, user, "owner");
    const ctx = await contextFor(db, { sessionUserId: user, channel: "web" });
    expect(await rejection(runAction("search_candidates", {}, ctx))).toMatchObject({ code: "subscription_required", status: 403 });
  });

  it("a guest has 50 paid pages a day per payer address", async () => {
    const ctx = await contextFor(db, { hasPayment: true }, { now: NOON });
    addUsage(db.raw, 50, { payer: "0xaaa", action: "search_candidates", at: "2026-09-12 01:00:00" });
    const err = await rejection(
      runAction("search_candidates", {}, ctx, { payment: { id: addPayment(db.raw, { payer: "0xaaa" }), payer: "0xaaa" } }),
    );
    expect(err).toMatchObject({ code: "daily_quota_exceeded", status: 429 });
    const ok = await runAction("search_candidates", {}, ctx, { payment: { id: addPayment(db.raw, { payer: "0xbbb" }), payer: "0xbbb" } });
    expect(ok.headers["RateLimit-Remaining"]).toBe("49");
  });
});

describe("monthly intro quota", () => {
  it("counts the Stripe billing period, not the calendar month or older periods", async () => {
    const { co, ctx } = await agent({ provider: "stripe", now: NOON });
    const sub = ctx.company!.subscription!;
    const period = { ...sub, periodStart: "2026-09-05 10:00:00", periodEnd: "2026-10-05 10:00:00" };
    // 39 у цьому періоді (у різні дні, щоб не впертися в денну межу) і 30 до нього.
    for (let d = 5; d <= 11; d++) {
      addUsage(db.raw, d === 11 ? 3 : 6, { companyId: co, action: "request_intro", at: `2026-09-${String(d).padStart(2, "0")} 12:00:00` });
    }
    addUsage(db.raw, 30, { companyId: co, action: "request_intro", at: "2026-09-05 09:59:59" });

    const record = { subject: { companyId: co }, action: "request_intro", channel: "rest" as const, billing: "included" as const };
    const names = ["request_intro_day", "request_intro_month"] as const;
    const first = await reserveUsage(db.d1, record, "subscription", names, period, NOON);
    expect(first.ok).toBe(true);
    const second = await reserveUsage(db.d1, record, "subscription", names, period, NOON);
    expect(second).toMatchObject({ ok: false, exceeded: { name: "request_intro_month", limit: 40, remaining: 0 } });
    if (!second.ok) expect(second.exceeded.resetsAt.toISOString()).toBe("2026-10-05T10:00:00.000Z");
  });

  it("manual and USDC access use the calendar month", () => {
    const w = monthWindow(NOON, { id: "sub", provider: "usdc", status: "active", periodStart: "2026-09-10 00:00:00", periodEnd: "2026-10-10 00:00:00" });
    expect(w).toEqual({ start: "2026-09-01 00:00:00", resetsAt: new Date("2026-10-01T00:00:00Z") });
  });
});

describe("get_account quotas", () => {
  it("shows what is left today and this month", async () => {
    const { co, ctx } = await agent({ now: NOON });
    addUsage(db.raw, 13, { companyId: co, action: "search_candidates", at: "2026-09-12 08:00:00" });
    addUsage(db.raw, 1, { companyId: co, action: "request_intro", at: "2026-09-12 08:00:00" });
    const res = await runAction("get_account", {}, ctx);
    expect((res.output as { quotas: unknown }).quotas).toEqual({
      search_candidates: { limit: 300, remaining: 287, resets_at: "2026-09-13T00:00:00Z" },
      get_candidate: { limit: 200, remaining: 200, resets_at: "2026-09-13T00:00:00Z" },
      request_intro_day: { limit: 10, remaining: 9, resets_at: "2026-09-13T00:00:00Z" },
      request_intro_month: { limit: 40, remaining: 39, resets_at: "2026-10-01T00:00:00Z" },
    });
  });
});

describe("burst limits", () => {
  it("answers 429 rate_limited when the Workers rate limiter says no, and skips without a binding", async () => {
    const { ctx } = await agent();
    const keys: string[] = [];
    const deny = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: false }) } as unknown as RateLimit;
    await expect(checkBurst({ RL_API: deny }, ctx.actor, "1.2.3.4")).rejects.toMatchObject({ code: "rate_limited", status: 429 });
    expect(keys).toEqual([`key:${(ctx.actor as { keyId: string }).keyId}`]);
    await expect(checkBurst({}, ctx.actor, "1.2.3.4")).resolves.toBeUndefined();
  });
});
