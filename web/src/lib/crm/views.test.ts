import { beforeEach, describe, expect, it } from "vitest";
import { newId } from "@/lib/ids";
import { addCompany, addMember, addScore, addSubscription, addUser, all, contextFor, crmDb, publishFormula, run } from "@/test/crm-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { readAction, runAction } from "./actions";
import { candidateLabel } from "./project";
import { candidatePanel, companyJobs, loadDashboard, recentActivity } from "./views";

let db: TestDb;
beforeEach(() => {
  db = crmDb();
  publishFormula(db.raw);
});

async function member(name: string) {
  const co = addCompany(db.raw, { name });
  addSubscription(db.raw, co);
  const user = addUser(db.raw, { email: `${name.toLowerCase()}@example.com`, visible: false });
  addMember(db.raw, co, user, "owner");
  return { co, ctx: await contextFor(db, { sessionUserId: user }) };
}

function candidate(): string {
  const id = addUser(db.raw);
  addScore(db.raw, id, "engineer", 75);
  return id;
}

describe("reads for the CRM screens", () => {
  it("readAction checks the action like runAction but writes no usage row; metered actions are refused", async () => {
    const a = await member("Acme");
    await readAction("list_pipeline", {}, a.ctx);
    await readAction("get_account", {}, a.ctx);
    expect(all(db.raw, "SELECT * FROM usage_events")).toEqual([]);
    await expect(readAction("search_candidates", {}, a.ctx)).rejects.toThrow("use runAction");
    await expect(readAction("add_note", { candidate_id: crypto.randomUUID(), body: "x" }, a.ctx)).rejects.toThrow("use runAction");
    await expect(readAction("list_pipeline", { stage: "nope" }, a.ctx)).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("dashboard, activity, panel and jobs stay inside the company", async () => {
    const a = await member("Acme");
    const b = await member("Beta");
    const x = candidate();
    await runAction("add_to_pipeline", { candidate_id: x }, a.ctx);
    await runAction("add_note", { candidate_id: x, body: "Acme only" }, a.ctx);
    run(
      db.raw,
      `INSERT INTO company_jobs (id, company_id, status, title, roles, created_via, apply_url, published_at, expires_at)
       VALUES (?, ?, 'open', 'Solidity engineer', '["engineer"]', 'web', 'https://acme.io/jobs/1', datetime('now'), datetime('now', '+60 days'))`,
      newId("job"),
      a.co,
    );

    const dashA = await loadDashboard(a.ctx);
    expect(dashA.counts.found).toBe(1);
    expect(dashA.jobs).toMatchObject([{ title: "Solidity engineer", live: true }]);
    const activityA = await recentActivity(a.ctx);
    expect(activityA.map((e) => e.text)).toEqual([
      `acme@example.com added a note on ${candidateLabel(x)}`,
      `acme@example.com added ${candidateLabel(x)} to the pipeline`,
    ]);
    expect((await companyJobs(a.ctx)).map((j) => j.linkable)).toEqual([true]);

    const dashB = await loadDashboard(b.ctx);
    expect(dashB.total).toBe(0);
    expect(dashB.jobs).toEqual([]);
    expect(await recentActivity(b.ctx)).toEqual([]);
    expect(await companyJobs(b.ctx)).toEqual([]);
    expect(await candidatePanel(b.ctx, x)).toEqual({ card: null, intro: null });
    expect((await candidatePanel(a.ctx, x)).card?.note_count).toBe(1);
  });
});
