import { beforeEach, describe, expect, it } from "vitest";
import {
  addApiKey,
  addCompany,
  addMember,
  addScore,
  addSubscription,
  addUser,
  all,
  contextFor,
  crmDb,
  publishFormula,
  run,
} from "@/test/crm-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { runAction } from "./actions";
import type { ActionContext } from "./context";
import type { SavedSearch, SavedSearchList } from "./saved-searches";
import { matchingIds } from "./search";
import { ActionError } from "./types";

const NOW = new Date("2026-09-12T12:00:00Z");

let db: TestDb;
beforeEach(() => {
  db = crmDb();
  publishFormula(db.raw);
});

async function company(name: string, o: { trial?: boolean; subscribed?: boolean } = {}) {
  const co = addCompany(db.raw, { name });
  if (o.subscribed ?? true) addSubscription(db.raw, co, { status: o.trial ? "trialing" : "active" });
  const memberId = addUser(db.raw, { visible: false });
  addMember(db.raw, co, memberId, "member");
  const { key } = await addApiKey(db.raw, co);
  return {
    co,
    member: await contextFor(db, { sessionUserId: memberId }, { now: NOW }),
    agent: await contextFor(db, { authorization: `Bearer ${key}` }, { now: NOW }),
  };
}

function candidate(score: number, o: Parameters<typeof addUser>[1] = {}): string {
  const id = addUser(db.raw, o);
  addScore(db.raw, id, "engineer", score);
  return id;
}

async function create(ctx: ActionContext, input: Record<string, unknown>): Promise<SavedSearch> {
  return (await runAction("create_saved_search", input, ctx)).output as SavedSearch;
}

async function rejection(p: Promise<unknown>): Promise<ActionError> {
  const e = await p.catch((err: unknown) => err);
  if (e instanceof ActionError) return e;
  throw new Error(`expected an ActionError, got ${String(e)}`);
}

function row(id: string): Record<string, unknown> {
  return all(db.raw, "SELECT * FROM saved_searches WHERE id = ?", id)[0];
}

describe("saved searches through the action registry", () => {
  it("create runs no search: last_match_count stays empty until the first alert, new matches count from baseline_at", async () => {
    const a = await company("Acme");
    candidate(80);
    const s = await create(a.member, { name: "  Solidity   engineers ", filters: { role: "engineer", min_score: 60 } });
    expect(s).toMatchObject({ name: "Solidity engineers", alert: "daily", sort: "score", last_match_count: null, last_alert_at: null });
    expect(row(s.saved_search_id)).toMatchObject({ seen_json: "[]", baseline_at: "2026-09-12 12:00:00", created_via: "web" });
    expect(all(db.raw, "SELECT * FROM usage_events WHERE action = 'search_candidates'")).toEqual([]);
  });

  it("a real filter or sort change moves baseline_at and clears last_match_count; rename and alert do not", async () => {
    const a = await company("Acme");
    const s = await create(a.agent, { name: "Engineers", filters: { role: "engineer", min_score: 70 } });
    // Сповіщення (cron T11) уже було: 3 нових.
    run(db.raw, "UPDATE saved_searches SET last_match_count = 3, last_alert_at = '2026-09-12 11:00:00' WHERE id = ?", s.saved_search_id);

    const later = { ...a.member, now: new Date("2026-09-12T15:00:00Z") };
    const renamed = (await runAction("update_saved_search", { saved_search_id: s.saved_search_id, name: "Solidity", alert: "off" }, later))
      .output as SavedSearch;
    expect(renamed).toMatchObject({ name: "Solidity", alert: "off", last_match_count: 3 });
    // Ті самі фільтри іншим порядком полів: не зміна.
    await runAction("update_saved_search", { saved_search_id: s.saved_search_id, filters: { min_score: 70, role: "engineer" } }, later);
    expect(row(s.saved_search_id)).toMatchObject({ baseline_at: "2026-09-12 12:00:00", last_match_count: 3, filter_changes: 0 });

    const changed = (await runAction("update_saved_search", { saved_search_id: s.saved_search_id, filters: { role: "engineer" } }, later))
      .output as SavedSearch;
    expect(changed).toMatchObject({ filters: { role: "engineer" }, last_match_count: null });
    expect(row(s.saved_search_id)).toMatchObject({ baseline_at: "2026-09-12 15:00:00", filter_changes: 1, filter_changes_day: "2026-09-12" });
    await runAction("update_saved_search", { saved_search_id: s.saved_search_id, sort: "newest" }, later);
    expect(row(s.saved_search_id)).toMatchObject({ filter_changes: 2 });
  });

  it("filters of one saved search change at most 10 times a day (UTC), then 429 until midnight", async () => {
    const a = await company("Acme");
    const s = await create(a.member, { name: "Engineers", filters: {} });
    const other = await create(a.member, { name: "Other", filters: {} });
    for (let i = 1; i <= 10; i++) {
      await runAction("update_saved_search", { saved_search_id: s.saved_search_id, filters: { min_score: i } }, a.member);
    }
    const e = await rejection(runAction("update_saved_search", { saved_search_id: s.saved_search_id, filters: { min_score: 50 } }, a.member));
    expect(e).toMatchObject({ code: "daily_quota_exceeded", status: 429 });
    expect(e.message).toBe("You can change the filters of one saved search up to 10 times a day. It resets at 00:00 UTC.");
    expect(e.headers?.["Retry-After"]).toBe(String(12 * 3600));
    expect(row(s.saved_search_id)).toMatchObject({ filter_changes: 10 });
    expect(JSON.parse(String(row(s.saved_search_id).filters_json))).toEqual({ min_score: 10 });
    // Назва й сповіщення далі змінюються; інший пошук має свою межу.
    await runAction("update_saved_search", { saved_search_id: s.saved_search_id, name: "Renamed" }, a.member);
    await runAction("update_saved_search", { saved_search_id: other.saved_search_id, filters: { min_score: 5 } }, a.member);
    // Наступна доба UTC: знову можна.
    const tomorrow = { ...a.member, now: new Date("2026-09-13T00:00:05Z") };
    await runAction("update_saved_search", { saved_search_id: s.saved_search_id, filters: { min_score: 50 } }, tomorrow);
    expect(row(s.saved_search_id)).toMatchObject({ filter_changes: 1, filter_changes_day: "2026-09-13" });
  });

  it("a trial company keeps up to 5 saved searches", async () => {
    const a = await company("Acme", { trial: true });
    for (let i = 0; i < 5; i++) await create(a.member, { name: `Search ${i}`, filters: {} });
    const e = await rejection(create(a.member, { name: "Sixth", filters: {} }));
    expect(e).toMatchObject({ code: "quota_exceeded", status: 403 });
    expect(e.message).toContain("Your trial allows 5 saved searches");
    expect(all(db.raw, "SELECT COUNT(*) AS n FROM saved_searches")).toEqual([{ n: 5 }]);
  });

  it("without a subscription the web app can only read them", async () => {
    const a = await company("Acme", { subscribed: false });
    expect(await rejection(create(a.member, { name: "S", filters: {} }))).toMatchObject({ code: "subscription_required" });
    expect(((await runAction("list_saved_searches", {}, a.member)).output as SavedSearchList).data).toEqual([]);
  });

  it("company B never sees, changes or deletes company A's saved searches", async () => {
    const a = await company("Acme");
    const b = await company("Beta");
    const s = await create(a.member, { name: "Acme only", filters: {} });

    expect(((await runAction("list_saved_searches", {}, b.member)).output as SavedSearchList).data).toEqual([]);
    expect(((await runAction("list_saved_searches", {}, b.agent)).output as SavedSearchList).data).toEqual([]);
    for (const ctx of [b.member, b.agent]) {
      expect(await rejection(runAction("update_saved_search", { saved_search_id: s.saved_search_id, name: "Mine" }, ctx))).toMatchObject({
        code: "not_found",
        status: 404,
      });
      expect(await rejection(runAction("delete_saved_search", { saved_search_id: s.saved_search_id }, ctx))).toMatchObject({
        code: "not_found",
      });
    }
    expect(all(db.raw, "SELECT name FROM saved_searches")).toEqual([{ name: "Acme only" }]);

    await runAction("delete_saved_search", { saved_search_id: s.saved_search_id }, a.agent);
    expect(all(db.raw, "SELECT COUNT(*) AS n FROM saved_searches")).toEqual([{ n: 0 }]);
  });
});

describe("matchingIds", () => {
  it("follows visibility for the company and the sort order, up to the limit", async () => {
    const a = await company("Acme");
    const top = candidate(90);
    const mid = candidate(70);
    const low = candidate(50);
    const member = addUser(db.raw);
    addScore(db.raw, member, "engineer", 95);
    addMember(db.raw, a.co, member, "member");

    expect(await matchingIds(a.member, { role: "engineer" })).toEqual([top, mid, low]);
    expect(await matchingIds(a.member, { role: "engineer" }, "score", 2)).toEqual([top, mid]);
    // Член команди не бачить себе, а інша компанія бачить його.
    const b = await company("Beta");
    expect(await matchingIds(b.member, { role: "engineer" })).toContain(member);
  });
});
