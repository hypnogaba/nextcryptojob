import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAction } from "@/lib/crm/actions";
import { respondToIntro } from "@/lib/crm/intros";
import { candidateLabel } from "@/lib/crm/project";
import { addMember, addUser, all, contextFor, crmDb, publishFormula, run } from "@/test/crm-fixtures";
import {
  addCandidate,
  addTestCompany,
  ask,
  BOT_TOKEN,
  introEnv,
  linkTelegram,
  nextTelegramId,
  NOW,
  stubNetwork,
  type Network,
  type TestCompany,
} from "@/test/intro-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { expireIntros } from "./intros";

let db: TestDb;
let net: Network;
let c: TestCompany;

beforeEach(async () => {
  db = crmDb();
  publishFormula(db.raw);
  net = stubNetwork();
  c = await addTestCompany(db, net);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const AFTER_14_DAYS = new Date("2026-09-26T12:00:00Z");
const notifier = { botToken: BOT_TOKEN, mailer: null, origin: "https://nextcryptojob.xyz" };
const intro = (id: string) => all<Record<string, unknown>>(db.raw, "SELECT * FROM intros WHERE id = ?", id)[0];
const stage = (user: string) => all<{ stage: string }>(db.raw, "SELECT stage FROM pipeline WHERE company_id = ? AND user_id = ?", c.co, user)[0]?.stage;

describe("expireIntros", () => {
  it("expires pending intros after 14 days: card back to found, token gone, logged, requester told", async () => {
    const alice = addCandidate(db);
    const id = (await ask(c.agent, alice.id)).output.intro_id;
    const before = net.tg.length;

    // Ще не час: нічого.
    expect(await expireIntros(db.d1, { notifier, now: new Date("2026-09-26T11:59:59Z") })).toEqual({ expired: 0, skipped: 0, notified: 0 });
    expect(intro(id).status).toBe("pending");

    expect(await expireIntros(db.d1, { notifier, now: AFTER_14_DAYS })).toEqual({ expired: 1, skipped: 0, notified: 1 });
    expect(intro(id)).toMatchObject({ status: "expired", respond_token_hash: null, webhook_state: "none", webhook_event: "intro.expired" });
    expect(stage(alice.id)).toBe("found");
    expect(
      all(db.raw, "SELECT e.kind, e.from_stage, e.to_stage, e.actor_kind FROM pipeline_events e JOIN pipeline p ON p.id = e.pipeline_id WHERE p.user_id = ? ORDER BY e.id", alice.id).at(-1),
    ).toEqual({ kind: "intro_expired", from_stage: "intro_requested", to_stage: "found", actor_kind: "system" });
    expect(all(db.raw, "SELECT actor, action FROM audit_log WHERE action IN ('intro.expire', 'pipeline.stage') ORDER BY id").slice(-2)).toEqual([
      { actor: `${c.co}:system`, action: "intro.expire" },
      { actor: `${c.co}:system`, action: "pipeline.stage" },
    ]);
    const told = net.tg.slice(before).filter((m) => m.method === "sendMessage");
    expect(told.map((m) => String(m.payload.chat_id))).toEqual([c.ownerTelegram]);
    expect(String(told[0].payload.text)).toContain(`No answer from ${candidateLabel(alice.id)} in 14 days.`);

    // Повторний запуск нічого не робить; компанія може спитати знову (1 запит за 90 днів).
    expect(await expireIntros(db.d1, { notifier, now: AFTER_14_DAYS })).toEqual({ expired: 0, skipped: 0, notified: 0 });
    const again = await ask({ ...c.agent, now: AFTER_14_DAYS }, alice.id);
    expect(again.output.status).toBe("pending");
  });

  it("leaves answered, canceled and fresh intros alone, and respects the batch limit", async () => {
    const people = [addCandidate(db), addCandidate(db), addCandidate(db), addCandidate(db)];
    const ids: string[] = [];
    for (const p of people) ids.push((await ask(c.agent, p.id)).output.intro_id);
    await respondToIntro(db.d1, { introId: ids[0], userId: people[0].id, decision: "accept", via: "web", now: NOW, notifier });
    await runAction("cancel_intro", { intro_id: ids[1] }, c.agent);

    expect(await expireIntros(db.d1, { notifier, now: AFTER_14_DAYS, limit: 1 })).toMatchObject({ expired: 1 });
    expect(await expireIntros(db.d1, { notifier, now: AFTER_14_DAYS, limit: 1 })).toMatchObject({ expired: 1 });
    expect(ids.map((id) => intro(id).status)).toEqual(["accepted", "canceled", "expired", "expired"]);
    expect(stage(people[0].id)).toBe("contact_shared");
    expect(stage(people[1].id)).toBe("found");
  });

  it("a member's request tells that member; a queued webhook goes out for intro.expired", async () => {
    run(db.raw, "UPDATE companies SET webhook_url = 'https://acme.io/hooks', webhook_enabled = 1 WHERE id = ?", c.co);
    const dana = addUser(db.raw, { visible: false });
    const danaTg = nextTelegramId();
    linkTelegram(db, dana, danaTg);
    addMember(db.raw, c.co, dana, "member");
    const memberCtx = await contextFor(db, { sessionUserId: dana }, { now: NOW, env: introEnv(net) });
    const alice = addCandidate(db);
    const id = (await ask(memberCtx, alice.id)).output.intro_id;
    const before = net.tg.length;

    await expireIntros(db.d1, { notifier, now: AFTER_14_DAYS });
    expect(intro(id)).toMatchObject({ webhook_state: "pending", webhook_event: "intro.expired", webhook_next_at: "2026-09-26 12:00:00" });
    expect(net.tg.slice(before).filter((m) => m.method === "sendMessage").map((m) => String(m.payload.chat_id))).toEqual([danaTg]);
  });

  it("an answer that lands at the same moment wins over the expiry", async () => {
    const alice = addCandidate(db);
    const id = (await ask(c.agent, alice.id)).output.intro_id;
    // Кандидат відповів, поки cron читав список.
    const [result] = await Promise.all([
      expireIntros(db.d1, { notifier, now: new Date("2026-09-26T12:00:00Z") }),
      respondToIntro(db.d1, { introId: id, userId: alice.id, decision: "decline", via: "web", now: new Date("2026-09-26T11:59:59Z"), notifier }),
    ]);
    const final = intro(id).status;
    expect(["declined", "expired"]).toContain(final);
    expect(result.expired + result.skipped).toBe(1);
    expect(stage(alice.id)).toBe(final === "declined" ? "declined" : "found");
  });
});
