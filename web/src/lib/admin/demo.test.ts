import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAction } from "@/lib/crm/actions";
import { notifierFromEnv } from "@/lib/crm/notify";
import { searchCandidates } from "@/lib/crm/search";
import type { ActionContext } from "@/lib/crm/context";
import type { SearchResponse } from "@/lib/crm/types";
import { loadVisits } from "@/lib/analytics/visits";
import { addUser, all, contextFor, crmDb, publishFormula, run, TEST_ENV } from "@/test/crm-fixtures";
import { addCandidate, addTestCompany, ask, introEnv, NOW, rejection, stubNetwork, type Network } from "@/test/intro-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { answerDemoIntro, createDemo, DEMO_CANDIDATES, deleteDemo, demoState, isDemoUserId, settleDemoIntros } from "./demo";
import { loadOverview } from "./overview";
import { loadWeeklyReport } from "./weekly";

/**
 * Демо-компанія: створюється адміном, бачить лише синтетичних кандидатів; реальна компанія,
 * гість x402, добірка, аналітика й лічильники адмінки демо не бачать; знайомство з демо
 * нікого не сповіщає, відповідь імітується; «Delete demo data» стирає все.
 */

let db: TestDb;
let net: Network;
let adminId: string;

beforeEach(() => {
  db = crmDb();
  publishFormula(db.raw);
  net = stubNetwork();
  adminId = addUser(db.raw, { visible: false, email: "boss@example.com" });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function demoCtx(now: Date = NOW): Promise<ActionContext> {
  return contextFor(db, { sessionUserId: adminId }, { now, env: introEnv(net) });
}

async function search(ctx: ActionContext, role = "engineer"): Promise<SearchResponse> {
  return (await runAction("search_candidates", { filters: { role } }, ctx)).output as SearchResponse;
}

const demoIds = () => all<{ id: string }>(db.raw, "SELECT id FROM users WHERE is_demo = 1").map((r) => r.id);
const idOf = (n: number) => demoIds().find((id) => id.startsWith(`de00${String(n).padStart(2, "0")}`))!;

describe("createDemo", () => {
  it("creates Demo Labs owned by the admin with a manual trial and 12 synthetic candidates, without wallets or contacts", async () => {
    const res = await createDemo(db.d1, adminId, NOW);
    expect(res).toMatchObject({ created: true, candidates: DEMO_CANDIDATES.length });
    expect(all(db.raw, "SELECT name, is_demo, status FROM companies")).toEqual([{ name: "Demo Labs", is_demo: 1, status: "active" }]);
    expect(all(db.raw, "SELECT role FROM company_members WHERE user_id = ?", adminId)).toEqual([{ role: "owner" }]);
    expect(all(db.raw, "SELECT provider, status FROM subscriptions")).toEqual([{ provider: "manual", status: "trialing" }]);
    expect(demoIds()).toHaveLength(12);
    expect(demoIds().every(isDemoUserId)).toBe(true);
    // Ні пошти, ні Telegram id, пауза добірки; нік із дефісом (у Telegram такого не буває).
    expect(all(db.raw, "SELECT COUNT(*) AS n FROM users WHERE is_demo = 1 AND (email IS NOT NULL OR telegram_id IS NOT NULL OR digest_paused = 0)")).toEqual([{ n: 0 }]);
    expect(all<{ u: string }>(db.raw, "SELECT telegram_username AS u FROM users WHERE is_demo = 1").every((r) => r.u.includes("-"))).toBe(true);
    expect(all(db.raw, "SELECT COUNT(*) AS n FROM identities WHERE kind IN ('evm', 'solana')")).toEqual([{ n: 0 }]);

    // Повтор не дублює нічого.
    expect(await createDemo(db.d1, adminId, NOW)).toMatchObject({ created: false });
    expect(all(db.raw, "SELECT COUNT(*) AS n FROM companies")).toEqual([{ n: 1 }]);
    expect(demoIds()).toHaveLength(12);
    expect(await demoState(db.d1, adminId)).toMatchObject({ candidates: 12, companies: [{ name: "Demo Labs", ownerIsYou: true }] });
  });
});

describe("demo isolation", () => {
  it("the demo company sees only demo candidates, best score first, and never a real person", async () => {
    const real = addCandidate(db);
    await createDemo(db.d1, adminId, NOW);
    const ctx = await demoCtx();
    expect(ctx.company?.isDemo).toBe(true);
    const res = await search(ctx);
    const ids = res.data.map((c) => c.candidate_id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every(isDemoUserId)).toBe(true);
    expect(ids).not.toContain(real.id);
    const scores = res.data.map((c) => c.headline.score ?? -1);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(res.data[0].label).toBe("#DE0001");
    await expect(rejection(runAction("get_candidate", { candidate_id: real.id }, ctx))).resolves.toMatchObject({ status: 404 });
  });

  it("a real company and an x402 guest never see a demo candidate, even by id", async () => {
    const real = addCandidate(db);
    await createDemo(db.d1, adminId, NOW);
    const company = await addTestCompany(db, net);
    const res = await search(company.owner);
    expect(res.data.map((c) => c.candidate_id)).toEqual([real.id]);
    const guest = await searchCandidates({ db: db.d1, company: null, env: TEST_ENV, now: NOW }, { filters: { role: "engineer" } });
    expect(guest.data.map((c) => c.candidate_id)).toEqual([real.id]);
    const view = (await runAction("get_candidate", { candidate_id: idOf(1) }, company.owner).catch((e) => e)) as { status?: number; output?: { visibility: string } };
    expect(view.status === 404 || view.output?.visibility === "hidden").toBe(true);
    await expect(rejection(runAction("request_intro", { candidate_id: idOf(2), message: "Hello, would you like to talk about a role at our company?" }, company.owner))).resolves.toMatchObject({
      status: 404,
    });
  });

  it("is not counted in the admin overview, the digest audience, the visit report or the weekly report", async () => {
    addCandidate(db);
    // Усе «зараз» за справжнім годинником: люди й демо створені сьогодні.
    const now = new Date();
    const before = await loadOverview(db.d1, now);
    await createDemo(db.d1, adminId, now);
    const after = await loadOverview(db.d1, now);
    expect(after.candidates).toEqual(before.candidates);
    expect(after.scores.usersScored).toBe(before.scores.usersScored);
    expect(after.scores.versions).toEqual(before.scores.versions);
    expect(after.digests.eligible).toBe(before.digests.eligible);
    expect(after.companies.trial).toBe(before.companies.trial);
    expect(after.companies.members).toBe(before.companies.members);
    const visits = await loadVisits(db.d1, now);
    const weekly = await loadWeeklyReport(db.d1, null, now);
    // Адмін і кандидат: двоє справжніх; дванадцять демо не рахуються.
    expect(before.candidates.total).toBe(2);
    expect(visits.totals.signups).toBe(2);
    expect(weekly.users.newUsers).toBe(2);
    expect(weekly.users.total).toBe(2);
    expect(weekly.companies.newCompanies).toBe(0);
  });

  it("jobs of a demo company never go live in digests or public job search", async () => {
    const { companyId } = await createDemo(db.d1, adminId, NOW);
    run(
      db.raw,
      `INSERT INTO company_jobs (id, company_id, status, title, apply_url, created_via, published_at, expires_at)
       VALUES ('job_DDDDDDDDDDDDDDDDDDDD', ?, 'open', 'Demo engineer', 'https://example.com', 'web', datetime('now'), datetime('now', '+60 days'))`,
      companyId,
    );
    expect(all(db.raw, "SELECT access FROM company_access WHERE company_id = ?", companyId)).toEqual([{ access: "subscription" }]);
    expect(all(db.raw, "SELECT id FROM company_jobs_live")).toEqual([]);
  });
});

describe("demo intros", () => {
  it("an intro to a demo candidate notifies nobody; simulate accept shares the demo handle and tells the requester", async () => {
    await createDemo(db.d1, adminId, NOW);
    const ctx = await demoCtx();
    const intro = (await ask(ctx, idOf(2))).output;
    expect(intro.status).toBe("pending");
    expect(intro.candidate_notified).toBe(true);
    expect(net.tg).toEqual([]);
    expect(net.mail).toEqual([]);

    const res = await answerDemoIntro(db.d1, { companyId: ctx.company!.id, introId: intro.intro_id, decision: "accept", notifier: notifierFromEnv(introEnv(net)), now: NOW });
    expect(res).toEqual({ ok: true, decision: "accept" });
    expect(all(db.raw, "SELECT status, contact_kind, contact_value FROM intros")).toEqual([
      { status: "accepted", contact_kind: "telegram", contact_value: "@ncj-demo-02" },
    ]);
    // Той, хто просив (адмін, лише пошта), дізнається, як від живої людини; кандидату не йде нічого.
    expect(net.mail.map((m) => m.to)).toEqual(["boss@example.com"]);
    expect(all(db.raw, "SELECT stage FROM pipeline")).toEqual([{ stage: "contact_shared" }]);
  });

  it("a candidate who chose Telegram handle directly reveals it at once, and nothing is sent", async () => {
    await createDemo(db.d1, adminId, NOW);
    const intro = (await ask(await demoCtx(), idOf(1))).output;
    expect(intro.status).toBe("direct");
    expect(intro.contact).toMatchObject({ kind: "telegram", value: "@ncj-demo-01", via: "direct" });
    expect(net.tg).toEqual([]);
    expect(net.mail).toEqual([]);
  });

  it("demo candidates answer by themselves a few seconds later; the decliners decline", async () => {
    await createDemo(db.d1, adminId, NOW);
    const ctx = await demoCtx();
    const a = (await ask(ctx, idOf(3))).output;
    const b = (await ask(ctx, idOf(9), { role: "bd" })).output;
    const notifier = notifierFromEnv(introEnv(net));
    expect(await settleDemoIntros(db.d1, ctx.company!.id, notifier, new Date(NOW.getTime() + 2_000))).toBe(0);
    expect(await settleDemoIntros(db.d1, ctx.company!.id, notifier, new Date(NOW.getTime() + 6_000))).toBe(2);
    const status = Object.fromEntries(all<{ id: string; status: string }>(db.raw, "SELECT id, status FROM intros").map((r) => [r.id, r.status]));
    expect(status[a.intro_id]).toBe("accepted");
    expect(status[b.intro_id]).toBe("declined");
  });

  it("simulate answers only a demo company's intro with a demo candidate", async () => {
    await createDemo(db.d1, adminId, NOW);
    const company = await addTestCompany(db, net);
    const real = addCandidate(db);
    const intro = (await ask(company.owner, real.id)).output;
    const res = await answerDemoIntro(db.d1, { companyId: company.co, introId: intro.intro_id, decision: "accept", notifier: notifierFromEnv(introEnv(net)) });
    expect(res).toEqual({ ok: false, reason: "not_demo" });
    expect(await settleDemoIntros(db.d1, company.co, notifierFromEnv(introEnv(net)), new Date(NOW.getTime() + 60_000))).toBe(0);
    expect(all(db.raw, "SELECT status FROM intros")).toEqual([{ status: "pending" }]);
  });
});

describe("deleteDemo", () => {
  it("removes demo companies and demo candidates with everything attached, and leaves real data", async () => {
    const real = addCandidate(db);
    await createDemo(db.d1, adminId, NOW);
    await ask(await demoCtx(), idOf(2));
    expect(await deleteDemo(db.d1, adminId, NOW)).toEqual({ companies: 1, candidates: 12 });
    expect(all(db.raw, "SELECT COUNT(*) AS n FROM users WHERE is_demo = 1")).toEqual([{ n: 0 }]);
    expect(all(db.raw, "SELECT COUNT(*) AS n FROM companies")).toEqual([{ n: 0 }]);
    expect(all(db.raw, "SELECT COUNT(*) AS n FROM intros")).toEqual([{ n: 0 }]);
    expect(all(db.raw, "SELECT COUNT(*) AS n FROM scores WHERE user_id <> ?", real.id)).toEqual([{ n: 0 }]);
    expect(all(db.raw, "SELECT id FROM users WHERE id = ?", real.id)).toEqual([{ id: real.id }]);
    expect(all(db.raw, "SELECT action FROM audit_log WHERE action LIKE 'demo.%' ORDER BY id")).toEqual([
      { action: "demo.create" },
      { action: "demo.delete" },
    ]);
  });
});
