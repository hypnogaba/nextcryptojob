import { beforeEach, describe, expect, it } from "vitest";
import { newId } from "@/lib/ids";
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
import { ACTIONS, runAction } from "./actions";
import type { ActionContext } from "./context";
import {
  checkManualTransition,
  getCard,
  introStageMove,
  introTransitionStatements,
  INTRO_EVENTS,
  normalizeTags,
  updateCard,
  type PipelineCard,
  type PipelineEventList,
  type PipelineList,
} from "./pipeline";
import { ActionError, STAGES, type Stage } from "./types";

let db: TestDb;
beforeEach(() => {
  db = crmDb();
  publishFormula(db.raw);
});

const NOW = new Date("2026-09-12T12:00:00Z");
const LATER = new Date("2026-09-13T09:30:00Z");

interface Company {
  co: string;
  keyId: string;
  agent: ActionContext;
  memberId: string;
  member: ActionContext;
}

async function company(name = "Acme Labs", o: { now?: Date; subscribed?: boolean } = {}): Promise<Company> {
  const co = addCompany(db.raw, { name });
  if (o.subscribed ?? true) addSubscription(db.raw, co);
  const { id: keyId, key } = await addApiKey(db.raw, co, { name: `${name} bot` });
  const memberId = addUser(db.raw, { visible: false });
  addMember(db.raw, co, memberId, "member");
  return {
    co,
    keyId,
    memberId,
    agent: await contextFor(db, { authorization: `Bearer ${key}` }, { now: o.now ?? NOW }),
    member: await contextFor(db, { sessionUserId: memberId }, { now: o.now ?? NOW }),
  };
}

async function at(c: Company, now: Date, as: "agent" | "member" = "agent"): Promise<ActionContext> {
  return { ...(as === "agent" ? c.agent : c.member), now };
}

/** Видимий кандидат з балом інженера. */
function candidate(score = 70, o: Parameters<typeof addUser>[1] = {}): string {
  const id = addUser(db.raw, o);
  addScore(db.raw, id, "engineer", score);
  return id;
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

async function add(ctx: ActionContext, id: string, extra: Record<string, unknown> = {}) {
  return runAction("add_to_pipeline", { candidate_id: id, ...extra }, ctx);
}

const card = (r: { output: unknown }) => r.output as PipelineCard;

function addIntro(
  co: string,
  user: string,
  o: { status?: "pending" | "accepted" | "direct" | "declined"; contact?: string; blocked?: boolean } = {},
): string {
  const id = newId("int");
  const status = o.status ?? "pending";
  const contact = status === "accepted" || status === "direct" ? (o.contact ?? "@alice_eth") : null;
  run(
    db.raw,
    `INSERT INTO intros (id, company_id, user_id, mode, status, message, requested_via, expires_at,
                         contact_kind, contact_value, respond_token_hash, candidate_blocked, responded_at)
     VALUES (?, ?, ?, ?, ?, 'We would like to talk to you about a role.', 'rest', datetime('now', '+14 days'),
             ?, ?, ?, ?, ?)`,
    id,
    co,
    user,
    status === "direct" ? "direct" : "approval",
    status,
    contact ? "telegram" : null,
    contact,
    status === "pending" ? `hash_${id}` : null,
    o.blocked ? 1 : 0,
    status === "pending" ? null : "2026-09-12 10:00:00",
  );
  return id;
}

function setStage(co: string, user: string, stage: Stage): void {
  run(
    db.raw,
    "UPDATE pipeline SET stage = ?, declined_by = ? WHERE company_id = ? AND user_id = ?",
    stage,
    stage === "declined" ? "candidate" : null,
    co,
    user,
  );
}

type EventRow = { kind: string; from_stage: string | null; to_stage: string | null; body: string | null; actor_kind: string; meta_json: string | null };
const events = (co: string, user: string) =>
  all<EventRow>(
    db.raw,
    `SELECT e.kind, e.from_stage, e.to_stage, e.body, e.actor_kind, e.meta_json FROM pipeline_events e
       JOIN pipeline p ON p.id = e.pipeline_id WHERE p.company_id = ? AND p.user_id = ? ORDER BY e.id`,
    co,
    user,
  );

type AuditRow = { actor: string; action: string; target: string | null; meta_json: string; at: string };
const audit = (action?: string) =>
  all<AuditRow>(
    db.raw,
    `SELECT actor, action, target, meta_json, at FROM audit_log ${action ? "WHERE action = ?" : ""} ORDER BY id`,
    ...(action ? [action] : []),
  );

const row = (co: string, user: string) =>
  all<{ stage: string; declined_by: string | null; stage_changed_at: string; updated_at: string; note_count: number; tags: string }>(
    db.raw,
    "SELECT stage, declined_by, stage_changed_at, updated_at, note_count, tags FROM pipeline WHERE company_id = ? AND user_id = ?",
    co,
    user,
  )[0];

// ---------------------------------------------------------------------------

describe("stage transitions (spec 5.4 table), through update_stage", () => {
  type Outcome = "ok" | "invalid_stage_transition" | "contact_not_shared";
  const MANUAL = ["found", "interview", "hired", "declined"] as const;
  // [без контакту, з відкритим контактом]; той самий етап не є переходом (no-op).
  const TABLE: Record<Stage, Partial<Record<(typeof MANUAL)[number], [Outcome, Outcome]>>> = {
    found: { interview: ["contact_not_shared", "ok"], hired: ["contact_not_shared", "ok"], declined: ["ok", "ok"] },
    intro_requested: {
      found: ["invalid_stage_transition", "invalid_stage_transition"],
      interview: ["invalid_stage_transition", "invalid_stage_transition"],
      hired: ["invalid_stage_transition", "invalid_stage_transition"],
      declined: ["invalid_stage_transition", "invalid_stage_transition"],
    },
    contact_shared: {
      found: ["ok", "ok"],
      interview: ["contact_not_shared", "ok"],
      hired: ["contact_not_shared", "ok"],
      declined: ["ok", "ok"],
    },
    interview: { found: ["ok", "ok"], hired: ["contact_not_shared", "ok"], declined: ["ok", "ok"] },
    hired: { found: ["ok", "ok"], interview: ["contact_not_shared", "ok"], declined: ["ok", "ok"] },
    declined: { found: ["ok", "ok"], interview: ["contact_not_shared", "ok"], hired: ["contact_not_shared", "ok"] },
  };

  const cases = STAGES.flatMap((from) =>
    MANUAL.filter((to) => to !== from).flatMap((to) =>
      ([false, true] as const).map((contact) => ({ from, to, contact, expected: TABLE[from][to]![contact ? 1 : 0] })),
    ),
  );

  it("covers every manual move from every stage", () => {
    expect(cases).toHaveLength(6 * 4 * 2 - 4 * 2);
  });

  it.each(cases)("$from -> $to (contact shared: $contact) = $expected", async ({ from, to, contact, expected }) => {
    const c = await company();
    const id = candidate();
    await add(c.agent, id);
    if (contact) addIntro(c.co, id, { status: "accepted" });
    setStage(c.co, id, from);
    const before = events(c.co, id).length;
    const auditBefore = audit().length;

    if (expected === "ok") {
      const res = await runAction("update_stage", { candidate_id: id, stage: to }, await at(c, LATER));
      expect(card(res).stage).toBe(to);
      expect(card(res).declined_by).toBe(to === "declined" ? "company" : null);
      expect(events(c.co, id).slice(before)).toEqual([
        { kind: "stage_changed", from_stage: from, to_stage: to, body: null, actor_kind: "agent", meta_json: null },
      ]);
      expect(audit().slice(auditBefore).map((a) => [a.action, JSON.parse(a.meta_json).from, JSON.parse(a.meta_json).to])).toEqual([
        ["pipeline.stage", from, to],
      ]);
      expect(row(c.co, id).stage_changed_at).toBe("2026-09-13 09:30:00");
      expect(row(c.co, id).updated_at).toBe("2026-09-13 09:30:00");
    } else {
      const err = await rejection(runAction("update_stage", { candidate_id: id, stage: to }, await at(c, LATER)));
      expect([err.code, err.status]).toEqual([expected, 409]);
      if (expected === "invalid_stage_transition") expect(err.message).toBe("Withdraw the pending intro first.");
      if (expected === "contact_not_shared") expect(err.message).toBe("Contact is not shared yet. Request an intro first.");
      expect(row(c.co, id).stage).toBe(from);
      expect(events(c.co, id)).toHaveLength(before);
      expect(audit()).toHaveLength(auditBefore);
    }
  });

  it("moving to the stage the card is already on changes nothing and writes nothing", async () => {
    const c = await company();
    const id = candidate();
    await add(c.agent, id);
    const before = { events: events(c.co, id).length, audit: audit().length, row: row(c.co, id) };
    const res = await runAction("update_stage", { candidate_id: id, stage: "found" }, await at(c, LATER));
    expect(card(res).stage).toBe("found");
    expect({ events: events(c.co, id).length, audit: audit().length, row: row(c.co, id) }).toEqual(before);
  });
});

describe("system-only stages", () => {
  it("members and agents cannot set intro_requested or contact_shared, through any path", async () => {
    const c = await company();
    const id = candidate();
    await add(c.agent, id);
    for (const ctx of [c.agent, c.member]) {
      for (const stage of ["intro_requested", "contact_shared"] as const) {
        const viaRegistry = await rejection(runAction("update_stage", { candidate_id: id, stage }, ctx));
        expect([viaRegistry.code, viaRegistry.status]).toEqual(["validation_failed", 422]);
        const direct = await rejection(updateCard(ctx, { candidate_id: id, stage }));
        expect([direct.code, direct.status, direct.message]).toEqual([
          "invalid_stage_transition",
          409,
          "This stage is set by the intro flow only.",
        ]);
      }
    }
    expect(row(c.co, id).stage).toBe("found");
    expect(events(c.co, id).map((e) => e.kind)).toEqual(["added"]);
  });

  it("the pure rule refuses the system-only targets from every stage, with or without contact", () => {
    for (const from of STAGES) {
      for (const to of ["intro_requested", "contact_shared"] as const) {
        for (const contact of [false, true]) expect(checkManualTransition(from, to, contact)?.code).toBe("invalid_stage_transition");
      }
    }
  });

  it("intro events move the card exactly as the table says", () => {
    const moves: Record<string, unknown> = {};
    for (const from of STAGES) {
      for (const event of INTRO_EVENTS) {
        try {
          moves[`${from} ${event}`] = introStageMove(from, event);
        } catch (e) {
          moves[`${from} ${event}`] = (e as ActionError).code;
        }
      }
    }
    // found -> intro_requested; any -> contact_shared; intro_requested -> declined (candidate) / found.
    expect(moves["found intro_requested"]).toEqual({ to: "intro_requested", declinedBy: null });
    for (const from of STAGES.filter((s) => s !== "found")) expect(moves[`${from} intro_requested`]).toBe("invalid_stage_transition");
    for (const from of STAGES) {
      const expected = from === "contact_shared" ? null : { to: "contact_shared", declinedBy: null };
      expect(moves[`${from} intro_accepted`]).toEqual(expected);
      expect(moves[`${from} contact_shared`]).toEqual(expected);
    }
    expect(moves["intro_requested intro_declined"]).toEqual({ to: "declined", declinedBy: "candidate" });
    expect(moves["intro_requested intro_expired"]).toEqual({ to: "found", declinedBy: null });
    expect(moves["intro_requested intro_canceled"]).toEqual({ to: "found", declinedBy: null });
    for (const from of STAGES.filter((s) => s !== "intro_requested")) {
      for (const e of ["intro_declined", "intro_expired", "intro_canceled"]) expect(moves[`${from} ${e}`]).toBeNull();
    }
  });

  it("the intro flow's statements move the card, write history and the audit log in one batch", async () => {
    const c = await company();
    const id = candidate();
    await add(c.agent, id);
    const introId = addIntro(c.co, id);

    await db.d1.batch(
      await introTransitionStatements(db.d1, { companyId: c.co, candidateId: id, event: "intro_requested", introId, now: LATER }),
    );
    expect(row(c.co, id)).toMatchObject({ stage: "intro_requested", stage_changed_at: "2026-09-13 09:30:00" });
    // Поки знайомство відкрите, картку вручну не зрушити.
    const err = await rejection(runAction("update_stage", { candidate_id: id, stage: "declined" }, c.member));
    expect([err.code, err.message]).toEqual(["invalid_stage_transition", "Withdraw the pending intro first."]);

    await db.d1.batch(
      await introTransitionStatements(db.d1, {
        companyId: c.co,
        candidateId: id,
        event: "intro_declined",
        introId,
        now: LATER,
        actor: { kind: "candidate", userId: id, keyId: null },
      }),
    );
    expect(row(c.co, id)).toMatchObject({ stage: "declined", declined_by: "candidate" });
    expect(events(c.co, id).map((e) => [e.kind, e.from_stage, e.to_stage, e.actor_kind])).toEqual([
      ["added", null, "found", "agent"],
      ["intro_requested", "found", "intro_requested", "system"],
      ["intro_declined", "intro_requested", "declined", "candidate"],
    ]);
    const stageAudit = audit("pipeline.stage");
    expect(stageAudit.map((a) => [a.actor, a.target, JSON.parse(a.meta_json).to])).toEqual([
      [`${c.co}:system`, id, "intro_requested"],
      [`${c.co}:system`, id, "declined"],
    ]);
  });
});

describe("every change is one batch: event, audit row, timestamps", () => {
  it("tags and job changes write their own events and audit rows but keep stage_changed_at", async () => {
    const c = await company();
    const id = candidate();
    const jobId = newId("job");
    run(db.raw, "INSERT INTO company_jobs (id, company_id, title, created_via) VALUES (?, ?, 'Solidity engineer', 'rest')", jobId, c.co);
    await add(c.member, id, { role: "engineer" });
    const res = await runAction("update_stage", { candidate_id: id, tags: ["lending"], job_id: jobId }, await at(c, LATER, "member"));
    expect(card(res)).toMatchObject({ tags: ["lending"], job_id: jobId, stage: "found", role: "engineer" });
    expect(row(c.co, id)).toMatchObject({ stage_changed_at: "2026-09-12 12:00:00", updated_at: "2026-09-13 09:30:00" });
    expect(events(c.co, id).map((e) => [e.kind, e.actor_kind, e.meta_json && JSON.parse(e.meta_json)])).toEqual([
      ["added", "member", { role: "engineer" }],
      ["tags_changed", "member", { tags: ["lending"] }],
      ["job_linked", "member", { job_id: jobId }],
    ]);
    const rows = audit();
    expect(rows.map((a) => [a.actor, a.action, a.target])).toEqual([
      [`${c.co}:member:${c.memberId}`, "pipeline.add", id],
      [`${c.co}:member:${c.memberId}`, "pipeline.tags", id],
      [`${c.co}:member:${c.memberId}`, "pipeline.job", id],
    ]);
    // Текст тегів у журнал не йде.
    expect(JSON.stringify(rows)).not.toContain("lending");
    expect(JSON.parse(rows[1].meta_json)).toEqual({ company_id: c.co, channel: "web", request_id: "req_test", tag_count: 1 });
  });

  it("a card that changed between reading and writing gets nothing written and a 409", async () => {
    const c = await company();
    const id = candidate();
    await add(c.agent, id);
    // Між читанням і пакетом процес знайомства перевів картку в intro_requested.
    const racing: D1Database = {
      ...db.d1,
      prepare: (sql: string) => db.d1.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        setStage(c.co, id, "intro_requested");
        return db.d1.batch(statements);
      },
    } as D1Database;
    const before = { events: events(c.co, id).length, audit: audit().length };
    const err = await rejection(updateCard({ ...c.agent, db: racing }, { candidate_id: id, stage: "declined" }));
    expect([err.code, err.status]).toEqual(["invalid_stage_transition", 409]);
    expect(row(c.co, id).stage).toBe("intro_requested");
    expect({ events: events(c.co, id).length, audit: audit().length }).toEqual(before);
  });
});

describe("add_to_pipeline", () => {
  it("creates the card at Found (201), then returns it unchanged (200)", async () => {
    const c = await company();
    const id = candidate(81);
    const first = await add(c.agent, id, { role: "engineer", tags: ["Solidity"] });
    expect(first.status).toBe(201);
    expect(card(first)).toMatchObject({
      candidate_id: id,
      visibility: "visible",
      stage: "found",
      declined_by: null,
      tags: ["Solidity"],
      note_count: 0,
      role: "engineer",
      headline: { role: "engineer", score: 81, level: 9 },
      contact: null,
      open_intro: null,
      created_at: "2026-09-12T12:00:00Z",
    });
    const again = await add(c.member, id, { tags: ["other"] });
    expect(again.status).toBe(200);
    expect(card(again).tags).toEqual(["Solidity"]);
    expect(audit("pipeline.add")).toHaveLength(1);
    expect(events(c.co, id)).toHaveLength(1);
  });

  it("refuses a candidate the company cannot see: hidden, without consent, blocking the company, unknown", async () => {
    const c = await company();
    const hidden = candidate(70, { visible: false });
    const noConsent = candidate(70, { consent: false });
    const blocker = candidate();
    addIntro(c.co, blocker, { status: "declined", blocked: true });
    for (const id of [hidden, noConsent, blocker, crypto.randomUUID()]) {
      const err = await rejection(add(c.agent, id));
      expect([err.code, err.status]).toEqual(["candidate_not_available", 404]);
    }
    expect(all(db.raw, "SELECT id FROM pipeline")).toEqual([]);
    expect(audit("pipeline.add")).toEqual([]);
  });

  it("links only the company's own job", async () => {
    const a = await company("A");
    const b = await company("B");
    const jobB = newId("job");
    run(db.raw, "INSERT INTO company_jobs (id, company_id, title, created_via) VALUES (?, ?, 'Growth lead', 'web')", jobB, b.co);
    const err = await rejection(add(a.agent, candidate(), { job_id: jobB }));
    expect([err.code, err.status]).toEqual(["not_found", 404]);
  });
});

describe("tags", () => {
  it("at most 10 tags of at most 32 characters", async () => {
    const c = await company();
    const id = candidate();
    await add(c.agent, id);
    const eleven = Array.from({ length: 11 }, (_, i) => `tag${i}`);
    for (const tags of [eleven, ["x".repeat(33)], ["  "], ["bad\u0007tag"]]) {
      const err = await rejection(runAction("update_stage", { candidate_id: id, tags }, c.agent));
      expect([err.code, err.status]).toEqual(["validation_failed", 422]);
    }
    const ten = Array.from({ length: 10 }, (_, i) => `tag${i}`);
    ten[0] = "y".repeat(32);
    expect(card(await runAction("update_stage", { candidate_id: id, tags: ten }, c.agent)).tags).toEqual(ten);
  });

  it("are case-insensitive: duplicates collapse to the first spelling, the filter ignores case in any alphabet", async () => {
    expect(normalizeTags(["DeFi", "defi", " DEFI ", "Аудит", "аудит", "solidity"])).toEqual(["DeFi", "Аудит", "solidity"]);
    expect(() => normalizeTags(Array.from({ length: 11 }, (_, i) => `t${i}`))).toThrow(ActionError);
    // Повтори не рахуються в межу 10.
    expect(normalizeTags([...Array.from({ length: 10 }, (_, i) => `t${i}`), "T0"])).toHaveLength(10);

    const c = await company();
    const a = candidate();
    const b = candidate();
    const d = candidate();
    await add(c.agent, a, { tags: ["Solidity"] });
    await add(c.agent, b, { tags: ["solidity", "Аудит"] });
    await add(c.agent, d, { tags: ["rust"] });
    const bySolidity = (await runAction("list_pipeline", { tag: "SOLIDITY" }, c.agent)).output as PipelineList;
    expect(bySolidity.data.map((x) => x.candidate_id).sort()).toEqual([a, b].sort());
    const byAudit = (await runAction("list_pipeline", { tag: "АУДИТ" }, c.agent)).output as PipelineList;
    expect(byAudit.data.map((x) => x.candidate_id)).toEqual([b]);
    const none = (await runAction("list_pipeline", { tag: "go" }, c.agent)).output as PipelineList;
    expect(none.data).toEqual([]);
    expect(none.counts.found).toBe(3);
  });
});

describe("notes", () => {
  it("are append-only: every note stays, in order, and nothing can edit or delete one", async () => {
    const c = await company();
    const id = candidate();
    await add(c.agent, id);
    const n1 = await runAction("add_note", { candidate_id: id, body: "Strong audits on lending protocols." }, c.member);
    expect(n1.status).toBe(201);
    expect(n1.output).toMatchObject({ kind: "note", body: "Strong audits on lending protocols.", actor: { kind: "member", name: null } });
    const n2 = await runAction("add_note", { candidate_id: id, body: "Call on Oct 3." }, await at(c, LATER));
    expect(n2.output).toMatchObject({ kind: "note", actor: { kind: "agent", name: "Acme Labs bot" }, created_at: "2026-09-13T09:30:00Z" });

    const history = (await runAction("list_candidate_history", { candidate_id: id }, c.agent)).output as PipelineEventList;
    expect(history.data.filter((e) => e.kind === "note").map((e) => e.body)).toEqual([
      "Strong audits on lending protocols.",
      "Call on Oct 3.",
    ]);
    expect(row(c.co, id)).toMatchObject({ note_count: 2, updated_at: "2026-09-13 09:30:00" });
    // Реєстр не має дії, що міняє чи видаляє нотатку.
    expect(ACTIONS.filter((a) => a.rest.path.includes("/notes")).map((a) => a.rest.method)).toEqual(["POST"]);
    // Журнал без тексту нотатки.
    const notes = audit("pipeline.note");
    expect(notes).toHaveLength(2);
    expect(JSON.stringify(notes)).not.toContain("audits");
  });

  it("a blank note is refused and a note needs a card", async () => {
    const c = await company();
    const id = candidate();
    const noCard = await rejection(runAction("add_note", { candidate_id: id, body: "Hello" }, c.agent));
    expect([noCard.code, noCard.status]).toEqual(["not_found", 404]);
    await add(c.agent, id);
    const blank = await rejection(runAction("add_note", { candidate_id: id, body: "   " }, c.agent));
    expect([blank.code, blank.status]).toEqual(["validation_failed", 422]);
  });
});

describe("remove_from_pipeline", () => {
  it("cancels the open intro, deletes the card and its history, keeps the audit log", async () => {
    const c = await company();
    const id = candidate();
    await add(c.agent, id);
    await runAction("add_note", { candidate_id: id, body: "A note" }, c.agent);
    const introId = addIntro(c.co, id);
    setStage(c.co, id, "intro_requested");
    const listed = (await runAction("list_pipeline", {}, c.agent)).output as PipelineList;
    expect(listed.data[0].open_intro).toMatchObject({ intro_id: introId });

    const res = await runAction("remove_from_pipeline", { candidate_id: id }, c.member);
    expect([res.status, res.output]).toEqual([204, {}]);
    expect(all(db.raw, "SELECT status, respond_token_hash FROM intros WHERE id = ?", introId)).toEqual([
      { status: "canceled", respond_token_hash: null },
    ]);
    expect(all(db.raw, "SELECT id FROM pipeline")).toEqual([]);
    expect(all(db.raw, "SELECT id FROM pipeline_events")).toEqual([]);
    const rows = audit();
    expect(rows.map((a) => a.action)).toEqual(["pipeline.add", "pipeline.note", "intro.cancel", "pipeline.remove"]);
    expect(JSON.parse(rows[2].meta_json)).toMatchObject({ intro_id: introId, reason: "card_removed" });

    // Знову додати можна: нова картка на found.
    expect(card(await add(c.agent, id)).stage).toBe("found");
    const gone = await rejection(runAction("remove_from_pipeline", { candidate_id: crypto.randomUUID() }, c.agent));
    expect([gone.code, gone.status]).toEqual(["not_found", 404]);
  });
});

describe("list_pipeline and history", () => {
  it("newest activity first, filters by stage and job, pages with a cursor, counts the whole pipeline", async () => {
    const c = await company();
    const jobId = newId("job");
    run(db.raw, "INSERT INTO company_jobs (id, company_id, title, created_via) VALUES (?, ?, 'Solidity engineer', 'rest')", jobId, c.co);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = candidate(60 + i);
      ids.push(id);
      await add({ ...c.agent, now: new Date(Date.UTC(2026, 8, 10 + i)) }, id, i === 1 ? { job_id: jobId } : {});
    }
    await runAction("update_stage", { candidate_id: ids[0], stage: "declined" }, await at(c, new Date("2026-09-20T00:00:00Z")));

    const page1 = (await runAction("list_pipeline", { limit: 2 }, c.agent)).output as PipelineList;
    expect(page1.data.map((x) => x.candidate_id)).toEqual([ids[0], ids[4]]);
    expect(page1.counts).toEqual({ found: 4, intro_requested: 0, contact_shared: 0, interview: 0, hired: 0, declined: 1 });
    const page2 = (await runAction("list_pipeline", { limit: 2, cursor: page1.next_cursor! }, c.agent)).output as PipelineList;
    expect(page2.data.map((x) => x.candidate_id)).toEqual([ids[3], ids[2]]);
    const page3 = (await runAction("list_pipeline", { limit: 2, cursor: page2.next_cursor! }, c.agent)).output as PipelineList;
    expect(page3.data.map((x) => x.candidate_id)).toEqual([ids[1]]);
    expect(page3.next_cursor).toBeNull();

    const declined = (await runAction("list_pipeline", { stage: "declined" }, c.agent)).output as PipelineList;
    expect(declined.data.map((x) => [x.candidate_id, x.declined_by])).toEqual([[ids[0], "company"]]);
    const byJob = (await runAction("list_pipeline", { job_id: jobId }, c.agent)).output as PipelineList;
    expect(byJob.data.map((x) => x.candidate_id)).toEqual([ids[1]]);

    const bad = await rejection(runAction("list_pipeline", { cursor: "not-a-cursor" }, c.agent));
    expect([bad.code, bad.status]).toEqual(["validation_failed", 422]);
  });

  it("history is oldest first, pages, names agents by key and people who left as Former member", async () => {
    const c = await company();
    const id = candidate();
    await add(c.member, id);
    await runAction("add_note", { candidate_id: id, body: "First" }, c.agent);
    await runAction("update_stage", { candidate_id: id, tags: ["a"] }, c.agent);
    run(db.raw, "DELETE FROM company_members WHERE user_id = ?", c.memberId);

    const p1 = (await runAction("list_candidate_history", { candidate_id: id, limit: 2 }, c.agent)).output as PipelineEventList;
    expect(p1.data.map((e) => [e.kind, e.actor])).toEqual([
      ["added", { kind: "member", name: "Former member" }],
      ["note", { kind: "agent", name: "Acme Labs bot" }],
    ]);
    const p2 = (await runAction("list_candidate_history", { candidate_id: id, cursor: p1.next_cursor! }, c.agent))
      .output as PipelineEventList;
    expect(p2.data.map((e) => [e.kind, e.meta])).toEqual([["tags_changed", { tags: ["a"] }]]);
    expect(p2.next_cursor).toBeNull();
  });
});

describe("tenant isolation", () => {
  it("company B can never read or change company A's card", async () => {
    const a = await company("A");
    const b = await company("B");
    const id = candidate();
    await add(a.agent, id, { tags: ["secret-a"] });
    await runAction("add_note", { candidate_id: id, body: "A's private note" }, a.agent);

    for (const [name, input] of [
      ["update_stage", { candidate_id: id, stage: "declined" }],
      ["update_stage", { candidate_id: id, tags: ["x"] }],
      ["add_note", { candidate_id: id, body: "B was here" }],
      ["remove_from_pipeline", { candidate_id: id }],
      ["list_candidate_history", { candidate_id: id }],
    ] as const) {
      const err = await rejection(runAction(name, input, b.agent));
      expect({ name, code: err.code, status: err.status }).toEqual({ name, code: "not_found", status: 404 });
    }
    const listB = (await runAction("list_pipeline", { tag: "secret-a" }, b.member)).output as PipelineList;
    expect(listB.data).toEqual([]);
    expect(Object.values(listB.counts).reduce((s, n) => s + n, 0)).toBe(0);
    expect(await getCard(db.d1, b.co, id)).toBeNull();

    // Своя картка B на того самого кандидата незалежна.
    await add(b.agent, id);
    await runAction("update_stage", { candidate_id: id, stage: "declined" }, b.agent);
    expect(row(a.co, id)).toMatchObject({ stage: "found", note_count: 1, tags: '["secret-a"]' });
    const historyB = (await runAction("list_candidate_history", { candidate_id: id }, b.agent)).output as PipelineEventList;
    expect(historyB.data.map((e) => e.kind)).toEqual(["added", "stage_changed"]);
  });
});

describe("permissions and access from the registry", () => {
  it("an x402 guest cannot touch the pipeline; a web member without a subscription can only read", async () => {
    const guest = await contextFor(db, { hasPayment: true });
    const g = await rejection(runAction("list_pipeline", {}, guest));
    expect([g.code, g.status]).toEqual(["key_required", 401]);

    const c = await company("Free", { subscribed: false });
    const id = candidate();
    expect(((await runAction("list_pipeline", {}, c.member)).output as PipelineList).data).toEqual([]);
    const w = await rejection(add(c.member, id));
    expect([w.code, w.status]).toEqual(["subscription_required", 403]);
    // Агент без підписки працює з воронкою (pay per request, дії безкоштовні).
    expect((await add(c.agent, id)).status).toBe(201);
  });

  it("pipeline actions are not metered against quotas but leave a usage row", async () => {
    const c = await company();
    const id = candidate();
    await add(c.agent, id);
    await runAction("list_pipeline", {}, c.agent);
    expect(all(db.raw, "SELECT action, billing, status FROM usage_events ORDER BY id")).toEqual([
      { action: "add_to_pipeline", billing: "free", status: 201 },
      { action: "list_pipeline", billing: "free", status: 200 },
    ]);
  });
});
