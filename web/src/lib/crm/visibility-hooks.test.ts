import { beforeEach, describe, expect, it } from "vitest";
import { newId } from "@/lib/ids";
import type { MailMessage, Mailer } from "@/lib/mail";
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
  setConsent,
} from "@/test/crm-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { runAction } from "./actions";
import { companyAuditRange } from "./audit";
import type { ActionContext } from "./context";
import type { PipelineEventList, PipelineList } from "./pipeline";
import { ActionError, CandidateView, HIDDEN_NOTICE, type SearchResponse } from "./types";
import {
  beforeCandidateErased,
  ERASED_SUBJECT,
  erasureBlockReason,
  LAST_OWNER_TEXT,
  onVisibilityChanged,
} from "./visibility";

let db: TestDb;
beforeEach(() => {
  db = crmDb();
  publishFormula(db.raw);
});

const NOW = new Date("2026-09-12T12:00:00Z");

async function company(name: string): Promise<{ co: string; ctx: ActionContext; ownerId: string }> {
  const co = addCompany(db.raw, { name });
  addSubscription(db.raw, co);
  const ownerId = addUser(db.raw, { visible: false, email: `owner@${name.toLowerCase()}.io` });
  addMember(db.raw, co, ownerId, "owner");
  const { key } = await addApiKey(db.raw, co);
  return { co, ownerId, ctx: await contextFor(db, { authorization: `Bearer ${key}` }, { now: NOW }) };
}

function acceptedIntro(co: string, user: string, contact = "@alice_eth"): string {
  const id = newId("int");
  run(
    db.raw,
    `INSERT INTO intros (id, company_id, user_id, mode, status, message, requested_via, expires_at, contact_kind, contact_value, responded_at)
     VALUES (?, ?, ?, 'approval', 'accepted', 'We would like to talk to you about a role.', 'rest', datetime('now', '+14 days'),
             'telegram', ?, '2026-09-12 10:00:00')`,
    id,
    co,
    user,
    contact,
  );
  return id;
}

function pendingIntro(co: string, user: string): string {
  const id = newId("int");
  run(
    db.raw,
    `INSERT INTO intros (id, company_id, user_id, mode, status, message, requested_via, expires_at, respond_token_hash)
     VALUES (?, ?, ?, 'approval', 'pending', 'We would like to talk to you about a role.', 'rest', datetime('now', '+14 days'), ?)`,
    id,
    co,
    user,
    `hash_${id}`,
  );
  return id;
}

/** Людина вимикає видимість у налаштуваннях: прапор, згода, потім хук (як робитиме доріжка налаштувань). */
async function hide(id: string): Promise<{ cards: number }> {
  run(db.raw, "UPDATE users SET visible_to_companies = 0 WHERE id = ?", id);
  return onVisibilityChanged(id, false, db.d1, NOW);
}

async function show(id: string): Promise<{ cards: number }> {
  run(db.raw, "UPDATE users SET visible_to_companies = 1 WHERE id = ?", id);
  setConsent(db.raw, id, "visibility", true);
  return onVisibilityChanged(id, true, db.d1, NOW);
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

const list = async (ctx: ActionContext) => (await runAction("list_pipeline", {}, ctx)).output as PipelineList;
const history = async (ctx: ActionContext, id: string) =>
  ((await runAction("list_candidate_history", { candidate_id: id }, ctx)).output as PipelineEventList).data;

describe("onVisibilityChanged", () => {
  it("visibility off: every card of the person shows visibility_lost, search excludes them, notes and contact stay", async () => {
    const a = await company("Acme");
    const b = await company("Beta");
    const other = await company("Gamma");
    const id = addUser(db.raw);
    addScore(db.raw, id, "engineer", 81);
    await runAction("add_to_pipeline", { candidate_id: id, tags: ["solidity"] }, a.ctx);
    await runAction("add_note", { candidate_id: id, body: "Strong audits." }, a.ctx);
    await runAction("add_to_pipeline", { candidate_id: id }, b.ctx);
    acceptedIntro(a.co, id);
    // Інша людина в тій самій воронці не зачеплена.
    const bystander = addUser(db.raw);
    addScore(db.raw, bystander, "engineer", 50);
    await runAction("add_to_pipeline", { candidate_id: bystander }, a.ctx);

    expect(await hide(id)).toEqual({ cards: 2 });

    for (const c of [a, b]) {
      const cards = (await list(c.ctx)).data.filter((x) => x.candidate_id === id);
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ visibility: "hidden", headline: null });
      expect((await history(c.ctx, id)).at(-1)).toMatchObject({ kind: "visibility_lost", actor: { kind: "system", name: null } });
    }
    const cardA = (await list(a.ctx)).data.find((x) => x.candidate_id === id)!;
    expect(cardA).toMatchObject({ tags: ["solidity"], note_count: 1, contact: { kind: "telegram", value: "@alice_eth", via: "intro" } });
    expect((await history(a.ctx, id)).map((e) => e.kind)).toEqual(["added", "note", "visibility_lost"]);
    expect((await list(a.ctx)).data.find((x) => x.candidate_id === bystander)?.visibility).toBe("visible");

    // Пошук і нове додавання його не бачать.
    const search = (await runAction("search_candidates", {}, other.ctx)).output as SearchResponse;
    expect(search.data.map((d) => d.candidate_id)).not.toContain(id);
    const add = await rejection(runAction("add_to_pipeline", { candidate_id: id }, other.ctx));
    expect([add.code, add.status]).toEqual(["candidate_not_available", 404]);

    // Профіль: HiddenCandidate з етапом, тегами й уже відкритим контактом, без балів.
    const view = CandidateView.parse((await runAction("get_candidate", { candidate_id: id }, a.ctx)).output);
    expect(view).toEqual({
      candidate_id: id,
      visibility: "hidden",
      label: `#${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      notice: HIDDEN_NOTICE,
      pipeline: { stage: "found", tags: ["solidity"] },
      contact: { kind: "telegram", value: "@alice_eth", shared_at: "2026-09-12T10:00:00Z", via: "intro" },
    });
    const viewB = CandidateView.parse((await runAction("get_candidate", { candidate_id: id }, b.ctx)).output);
    expect(viewB).toMatchObject({ visibility: "hidden", contact: null });
    const viewOther = await rejection(runAction("get_candidate", { candidate_id: id }, other.ctx));
    expect(viewOther.code).toBe("candidate_not_available");

    // Журнал кожної компанії має рядок про втрату видимості.
    for (const c of [a, b]) {
      const { lo, hi } = companyAuditRange(c.co);
      const rows = all<{ actor: string; action: string; target: string }>(
        db.raw,
        "SELECT actor, action, target FROM audit_log WHERE actor >= ? AND actor < ? AND action LIKE 'pipeline.visibility%'",
        lo,
        hi,
      );
      expect(rows).toEqual([{ actor: `${c.co}:system`, action: "pipeline.visibility_lost", target: id }]);
    }
  });

  it("calling it again with the same state writes nothing; visibility on again restores the cards", async () => {
    const a = await company("Acme");
    const id = addUser(db.raw);
    addScore(db.raw, id, "engineer", 81);
    await runAction("add_to_pipeline", { candidate_id: id }, a.ctx);

    expect(await onVisibilityChanged(id, true, db.d1, NOW)).toEqual({ cards: 0 }); // ніколи не ховався
    expect(await hide(id)).toEqual({ cards: 1 });
    expect(await hide(id)).toEqual({ cards: 0 });
    expect(await show(id)).toEqual({ cards: 1 });
    expect(await show(id)).toEqual({ cards: 0 });

    const card = (await list(a.ctx)).data[0];
    expect(card).toMatchObject({ visibility: "visible", headline: { role: "engineer", score: 81 } });
    expect((await history(a.ctx, id)).map((e) => e.kind)).toEqual(["added", "visibility_lost", "visibility_restored"]);
    const search = (await runAction("search_candidates", {}, a.ctx)).output as SearchResponse;
    expect(search.data.map((d) => d.candidate_id)).toEqual([id]);
    expect(CandidateView.parse((await runAction("get_candidate", { candidate_id: id }, a.ctx)).output).visibility).toBe("visible");
    expect(all(db.raw, "SELECT action FROM audit_log WHERE action LIKE 'pipeline.visibility%' ORDER BY id")).toEqual([
      { action: "pipeline.visibility_lost" },
      { action: "pipeline.visibility_restored" },
    ]);
  });

  it("an open intro survives hiding: the candidate can still answer it", async () => {
    const a = await company("Acme");
    const id = addUser(db.raw);
    await runAction("add_to_pipeline", { candidate_id: id }, a.ctx);
    const introId = pendingIntro(a.co, id);
    await hide(id);
    expect(all(db.raw, "SELECT status FROM intros WHERE id = ?", introId)).toEqual([{ status: "pending" }]);
    expect((await list(a.ctx)).data[0].open_intro?.intro_id).toBe(introId);
  });
});

describe("beforeCandidateErased", () => {
  function recorder(fail = false): Mailer & { sent: MailMessage[] } {
    const sent: MailMessage[] = [];
    return {
      sent,
      async send(m) {
        if (fail) throw new Error("E_RATE_LIMIT_EXCEEDED");
        sent.push(m);
      },
    };
  }

  it("logs candidate.erased, cancels open intros, mails owners who had the contact; the delete cascades, the log stays", async () => {
    const shared = await company("Acme");
    const cardOnly = await company("Beta");
    const pending = await company("Gamma");
    const untouched = await company("Delta");
    addMember(db.raw, shared.co, addUser(db.raw, { visible: false, email: "member@acme.io" }), "member");
    const id = addUser(db.raw, { email: "alice@example.com", telegram: "alice_eth" });
    for (const c of [shared, cardOnly, pending]) await runAction("add_to_pipeline", { candidate_id: id }, c.ctx);
    await runAction("add_note", { candidate_id: id, body: "Private note" }, shared.ctx);
    acceptedIntro(shared.co, id);
    const open = pendingIntro(pending.co, id);

    const mailer = recorder();
    const result = await beforeCandidateErased(id, { db: db.d1, mailer, now: NOW });
    expect(result).toEqual({ companies: 3, contactShared: 1, mailed: 1, mailFailed: 0 });
    expect(all(db.raw, "SELECT status FROM intros WHERE id = ?", open)).toEqual([{ status: "canceled" }]);

    const erased = all<{ actor: string; target: string; meta_json: string }>(
      db.raw,
      "SELECT actor, target, meta_json FROM audit_log WHERE action = 'candidate.erased' ORDER BY actor",
    );
    const expected = [
      { co: shared.co, contact_shared: true, intro_canceled: false },
      { co: cardOnly.co, contact_shared: false, intro_canceled: false },
      { co: pending.co, contact_shared: false, intro_canceled: true },
    ].sort((x, y) => (x.co < y.co ? -1 : 1));
    expect(erased.map((r) => ({ actor: r.actor, target: r.target, meta: JSON.parse(r.meta_json) }))).toEqual(
      expected.map((e) => ({
        actor: `${e.co}:system`,
        target: id,
        meta: { company_id: e.co, contact_shared: e.contact_shared, intro_canceled: e.intro_canceled },
      })),
    );
    expect(erased.map((r) => r.actor)).not.toContain(`${untouched.co}:system`);

    // Лист лише власникам компанії, якій відкрито контакт; без контакту людини в листі.
    expect(mailer.sent.map((m) => [m.to, m.subject])).toEqual([["owner@acme.io", ERASED_SUBJECT]]);
    expect(mailer.sent[0].text).toContain("Please delete any copy of their contact details you keep outside NextCryptoJob.");
    expect(mailer.sent[0].text).not.toContain("alice");
    expect(mailer.sent[0].text).not.toContain("\u2014");

    // Доріжка налаштувань видаляє рядок users: каскад прибирає картки, історію, нотатки й знайомства.
    const auditBefore = all(db.raw, "SELECT id FROM audit_log").length;
    run(db.raw, "DELETE FROM users WHERE id = ?", id);
    expect(all(db.raw, "SELECT id FROM pipeline WHERE user_id = ?", id)).toEqual([]);
    expect(all(db.raw, "SELECT id FROM pipeline_events")).toEqual([]);
    expect(all(db.raw, "SELECT id FROM intros WHERE user_id = ?", id)).toEqual([]);
    expect(all(db.raw, "SELECT id FROM audit_log").length).toBe(auditBefore);
    expect(all(db.raw, "SELECT id FROM audit_log WHERE target = ? AND action = 'pipeline.note'", id)).toHaveLength(1);
  });

  it("a mail failure or missing mail does not stop the erasure", async () => {
    const shared = await company("Acme");
    const id = addUser(db.raw);
    await runAction("add_to_pipeline", { candidate_id: id }, shared.ctx);
    acceptedIntro(shared.co, id);
    expect(await beforeCandidateErased(id, { db: db.d1, mailer: recorder(true), now: NOW })).toMatchObject({ mailed: 0, mailFailed: 1 });
    expect(await beforeCandidateErased(id, { db: db.d1, mailer: null, now: NOW })).toMatchObject({ mailed: 0, mailFailed: 1 });
  });

  it("a person with no cards or intros leaves nothing", async () => {
    const id = addUser(db.raw);
    expect(await beforeCandidateErased(id, { db: db.d1, mailer: recorder(), now: NOW })).toEqual({
      companies: 0,
      contactShared: 0,
      mailed: 0,
      mailFailed: 0,
    });
    expect(all(db.raw, "SELECT id FROM audit_log")).toEqual([]);
  });
});

describe("erasureBlockReason", () => {
  it("blocks the last owner of an open company, not a member or one of two owners", async () => {
    const { co, ownerId } = await company("Acme");
    expect(await erasureBlockReason(ownerId, db.d1)).toBe(LAST_OWNER_TEXT);
    const second = addUser(db.raw, { visible: false });
    addMember(db.raw, co, second, "owner");
    expect(await erasureBlockReason(ownerId, db.d1)).toBeNull();
    const member = addUser(db.raw, { visible: false });
    addMember(db.raw, co, member, "member");
    expect(await erasureBlockReason(member, db.d1)).toBeNull();
    const solo = await company("Solo");
    run(db.raw, "UPDATE companies SET status = 'closed' WHERE id = ?", solo.co);
    expect(await erasureBlockReason(solo.ownerId, db.d1)).toBeNull();
  });
});
