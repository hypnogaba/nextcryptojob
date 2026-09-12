import { beforeEach, describe, expect, it } from "vitest";
import {
  addApiKey,
  addCompany,
  addMember,
  addPayment,
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
import { companyAuditRange } from "./audit";

let db: TestDb;
beforeEach(() => {
  db = crmDb();
  publishFormula(db.raw);
});

type AuditRow = { actor: string; action: string; target: string | null; meta_json: string; at: string };
const audit = () => all<AuditRow>(db.raw, "SELECT actor, action, target, meta_json, at FROM audit_log ORDER BY id");

describe("audit log for actions on candidates", () => {
  it("a search page writes one row with the result ids; a profile view writes one row with the candidate", async () => {
    const co = addCompany(db.raw);
    addSubscription(db.raw, co);
    const { id: keyId, key } = await addApiKey(db.raw, co);
    const a = addUser(db.raw, { email: "a@example.com", telegram: "a_tg" });
    const b = addUser(db.raw);
    addScore(db.raw, a, "engineer", 70);
    addScore(db.raw, b, "engineer", 60);
    const ctx = await contextFor(db, { authorization: `Bearer ${key}`, channel: "mcp" });

    await runAction("search_candidates", { filters: { role: "engineer" } }, ctx);
    await runAction("get_candidate", { candidate_id: b }, ctx);

    const rows = audit();
    expect(rows.map((r) => [r.actor, r.action, r.target])).toEqual([
      [`${co}:agent:${keyId}`, "candidate.search", null],
      [`${co}:agent:${keyId}`, "candidate.view", b],
    ]);
    expect(JSON.parse(rows[0].meta_json)).toEqual({ company_id: co, channel: "mcp", request_id: "req_test", ids: [a, b], page: 1 });
    expect(JSON.parse(rows[1].meta_json)).toEqual({ company_id: co, channel: "mcp", request_id: "req_test" });
    expect(rows[0].at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // Журнал живе довше за дані: жодних пошт і ніків.
    expect(JSON.stringify(rows)).not.toMatch(/@|a_tg/);
  });

  it("a member's action is written with their user id; a guest's with the payment id, not the wallet", async () => {
    const user = addUser(db.raw, { visible: false });
    const co = addCompany(db.raw);
    addSubscription(db.raw, co);
    addMember(db.raw, co, user, "member");
    await runAction("search_candidates", {}, await contextFor(db, { sessionUserId: user, channel: "web" }));

    const payer = "0x4444444444444444444444444444444444444444";
    const pay = addPayment(db.raw, { payer });
    await runAction("search_candidates", {}, await contextFor(db, { hasPayment: true }), { payment: { id: pay, payer } });

    const rows = audit();
    expect(rows.map((r) => r.actor)).toEqual([`${co}:member:${user}`, `x402_guest:${pay}`]);
    expect(JSON.parse(rows[1].meta_json)).toMatchObject({ company_id: null, channel: "rest" });
    expect(JSON.stringify(rows)).not.toContain(payer);
  });

  it("a failed action is not written as done", async () => {
    const co = addCompany(db.raw);
    addSubscription(db.raw, co);
    const { key } = await addApiKey(db.raw, co);
    const ctx = await contextFor(db, { authorization: `Bearer ${key}` });
    await expect(runAction("get_candidate", { candidate_id: crypto.randomUUID() }, ctx)).rejects.toMatchObject({ status: 404 });
    await expect(runAction("get_candidate", { candidate_id: "not-a-uuid" }, ctx)).rejects.toMatchObject({ code: "validation_failed" });
    expect(audit()).toEqual([]);
  });

  it("the company range of the actor index covers exactly that company", async () => {
    const one = addCompany(db.raw);
    const two = addCompany(db.raw);
    for (const co of [one, two]) {
      addSubscription(db.raw, co);
      const { key } = await addApiKey(db.raw, co);
      await runAction("search_candidates", {}, await contextFor(db, { authorization: `Bearer ${key}` }));
    }
    const { lo, hi } = companyAuditRange(one);
    const rows = all<{ actor: string }>(db.raw, "SELECT actor FROM audit_log WHERE actor >= ? AND actor < ?", lo, hi);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor.startsWith(`${one}:`)).toBe(true);
  });
});
