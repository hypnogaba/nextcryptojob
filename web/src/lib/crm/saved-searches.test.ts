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
} from "@/test/crm-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { runAction } from "./actions";
import type { ActionContext } from "./context";
import type { SavedSearch, SavedSearchList } from "./saved-searches";
import { matchingIds } from "./search";
import { ActionError } from "./types";

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
    member: await contextFor(db, { sessionUserId: memberId }),
    agent: await contextFor(db, { authorization: `Bearer ${key}` }),
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

function seen(id: string): string[] {
  return JSON.parse(all<{ seen_json: string }>(db.raw, "SELECT seen_json FROM saved_searches WHERE id = ?", id)[0].seen_json);
}

describe("saved searches through the action registry", () => {
  it("remembers the current matches as seen, so the first alert reports only new people", async () => {
    const a = await company("Acme");
    const strong = candidate(80);
    const weak = candidate(40);
    const hidden = candidate(90, { visible: false });

    const s = await create(a.member, { name: "  Solidity   engineers ", filters: { role: "engineer", min_score: 60 } });
    expect(s).toMatchObject({ name: "Solidity engineers", alert: "daily", sort: "score", last_match_count: 1 });
    expect(seen(s.saved_search_id)).toEqual([strong]);
    expect(seen(s.saved_search_id)).not.toContain(weak);
    expect(seen(s.saved_search_id)).not.toContain(hidden);
    expect(all(db.raw, "SELECT created_via, created_by_user_id IS NOT NULL AS by_user FROM saved_searches")).toEqual([
      { created_via: "web", by_user: 1 },
    ]);
  });

  it("changing filters marks the new matches as seen; switching the alert does not", async () => {
    const a = await company("Acme");
    const x = candidate(80);
    const y = candidate(50);
    const s = await create(a.agent, { name: "Engineers", filters: { role: "engineer", min_score: 70 } });
    expect(seen(s.saved_search_id)).toEqual([x]);

    await runAction("update_saved_search", { saved_search_id: s.saved_search_id, alert: "off" }, a.member);
    expect(seen(s.saved_search_id)).toEqual([x]);

    const changed = (await runAction("update_saved_search", { saved_search_id: s.saved_search_id, filters: { role: "engineer" } }, a.member))
      .output as SavedSearch;
    expect(changed).toMatchObject({ alert: "off", filters: { role: "engineer" } });
    expect(seen(s.saved_search_id).sort()).toEqual([x, y].sort());
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
