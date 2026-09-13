import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, crmDb, publishFormula, run } from "@/test/crm-fixtures";
import {
  addCandidate,
  addTestCompany,
  ask,
  BOT_TOKEN,
  NOW,
  rejection,
  stubNetwork,
  tokenFromMail,
  type Network,
  type TestCompany,
} from "@/test/intro-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { runAction } from "./actions";
import { answerText, authorizeCandidate, loadIntroForCandidate, respondToIntro, type IntroDecision, type RespondOutcome } from "./intros";
import { candidateLabel } from "./project";
import { searchCandidates } from "./search";
import type { CandidateView, Intro } from "./types";
import { isVisibleTo } from "./visibility";

let db: TestDb;
let net: Network;

beforeEach(() => {
  db = crmDb();
  publishFormula(db.raw);
  net = stubNetwork();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const LATER = new Date("2026-09-13T09:00:00Z");
const notifier = () => ({ botToken: BOT_TOKEN, mailer: null, origin: "https://nextcryptojob.xyz" });

function respond(introId: string, userId: string, decision: IntroDecision, now = LATER): Promise<RespondOutcome> {
  return respondToIntro(db.d1, { introId, userId, decision, via: "web", now, notifier: notifier() });
}

const introRow = (id: string) => all<Record<string, unknown>>(db.raw, "SELECT * FROM intros WHERE id = ?", id)[0];
const stageOf = (co: string, user: string) =>
  all<{ stage: string; declined_by: string | null }>(db.raw, "SELECT stage, declined_by FROM pipeline WHERE company_id = ? AND user_id = ?", co, user)[0];
const eventKinds = (co: string, user: string) =>
  all<{ kind: string }>(
    db.raw,
    `SELECT e.kind FROM pipeline_events e JOIN pipeline p ON p.id = e.pipeline_id WHERE p.company_id = ? AND p.user_id = ? ORDER BY e.id`,
    co,
    user,
  ).map((e) => e.kind);
const audit = (action: string) => all<{ actor: string; target: string; meta_json: string }>(db.raw, "SELECT actor, target, meta_json FROM audit_log WHERE action = ?", action);

function snapshot() {
  return {
    intros: all(db.raw, "SELECT * FROM intros"),
    pipeline: all(db.raw, "SELECT * FROM pipeline"),
    events: all(db.raw, "SELECT * FROM pipeline_events"),
    audit: all(db.raw, "SELECT * FROM audit_log"),
  };
}

let c: TestCompany;
beforeEach(async () => {
  c = await addTestCompany(db, net);
});

async function pending(o: Parameters<typeof addCandidate>[1] = {}): Promise<{ id: string; telegramId: string | null; intro: Intro }> {
  const who = addCandidate(db, o);
  const res = await ask(c.agent, who.id);
  return { ...who, intro: res.output };
}

describe("accept", () => {
  it("snapshots the Telegram handle, moves the card to contact_shared and tells the requester without the contact", async () => {
    const alice = await pending({ email: "alice@gmail.com" });
    const tgBefore = net.tg.length;
    const outcome = await respond(alice.intro.intro_id, alice.id, "accept");
    expect(outcome).toEqual({ kind: "accepted", companyName: "Acme Labs", contactKind: "telegram" });
    expect(answerText(outcome)).toBe("Done. Acme Labs can now see your Telegram handle.");

    expect(introRow(alice.intro.intro_id)).toMatchObject({
      status: "accepted",
      contact_kind: "telegram",
      contact_value: "@alice_eth",
      responded_at: "2026-09-13 09:00:00",
      respond_token_hash: null,
      webhook_state: "none",
      webhook_event: "intro.accepted",
    });
    expect(stageOf(c.co, alice.id)).toEqual({ stage: "contact_shared", declined_by: null });
    expect(eventKinds(c.co, alice.id)).toEqual(["added", "intro_requested", "intro_accepted"]);
    expect(audit("intro.accept")).toEqual([
      {
        actor: `${c.co}:candidate`,
        target: alice.id,
        meta_json: JSON.stringify({ company_id: c.co, intro_id: alice.intro.intro_id, via: "web", blocked: false }),
      },
    ]);

    // Компанія бачить контакт у своєму знайомстві й у профілі.
    const status = (await runAction("intro_status", { intro_id: alice.intro.intro_id }, c.agent)).output as Intro;
    expect(status.contact).toEqual({ kind: "telegram", value: "@alice_eth", shared_at: "2026-09-13T09:00:00Z", via: "intro" });
    const profile = (await runAction("get_candidate", { candidate_id: alice.id }, c.agent)).output as CandidateView;
    expect(profile.contact).toMatchObject({ value: "@alice_eth" });

    // Той, хто просив (агент → власник), отримав повідомлення без контакту.
    const sent = net.tg.slice(tgBefore).filter((m) => m.method === "sendMessage");
    expect(sent.map((m) => String(m.payload.chat_id))).toEqual([c.ownerTelegram]);
    const text = String(sent[0].payload.text);
    expect(text).toContain(`Candidate ${candidateLabel(alice.id)} accepted your intro request. Open the pipeline to see the contact.`);
    expect(text).not.toContain("alice_eth");
    expect(text).not.toContain("alice@gmail.com");
    expect(text).not.toMatch(/@\w/);
  });

  it("without a Telegram handle the email is shared, and the requester's email says nothing about it either", async () => {
    run(db.raw, "UPDATE users SET channel = 'email', telegram_id = NULL WHERE id = ?", c.ownerId);
    const who = addCandidate(db, { telegram: null, email: "bob@proton.me" });
    const res = await ask(c.owner, who.id);
    const mailer = { sent: [] as { to: string; subject: string; text: string; html: string }[], async send(m: { to: string; subject: string; text: string; html: string }) { this.sent.push(m); } };
    const outcome = await respondToIntro(db.d1, {
      introId: res.output.intro_id,
      userId: who.id,
      decision: "accept",
      via: "web",
      now: LATER,
      notifier: { botToken: BOT_TOKEN, mailer, origin: "https://nextcryptojob.xyz" },
    });
    expect(outcome).toMatchObject({ kind: "accepted", contactKind: "email" });
    expect(answerText(outcome)).toBe("Done. Acme Labs can now see your email address.");
    expect(introRow(res.output.intro_id)).toMatchObject({ contact_kind: "email", contact_value: "bob@proton.me" });
    // Просив власник (сесія): лист йому, без адреси кандидата.
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].subject).toBe(`Candidate ${candidateLabel(who.id)} accepted your intro request`);
    expect(JSON.stringify(mailer.sent[0])).not.toContain("bob@proton.me");
    expect(mailer.sent[0].text).toContain("https://nextcryptojob.xyz/company/pipeline");
  });

  it("queues the intro.accepted webhook when the company has one", async () => {
    run(db.raw, "UPDATE companies SET webhook_url = 'https://acme.io/hooks', webhook_enabled = 1 WHERE id = ?", c.co);
    const alice = await pending();
    await respond(alice.intro.intro_id, alice.id, "accept");
    expect(introRow(alice.intro.intro_id)).toMatchObject({
      webhook_state: "pending",
      webhook_event: "intro.accepted",
      webhook_next_at: "2026-09-13 09:00:00",
      webhook_attempts: 0,
    });
  });

  it("cannot share nothing: without a handle and an email the intro stays pending", async () => {
    const ghost = await pending({ telegram: null, email: null });
    const before = snapshot();
    expect(await respond(ghost.intro.intro_id, ghost.id, "accept")).toEqual({ kind: "no_contact" });
    expect(snapshot()).toEqual(before);
    // Відмовити можна.
    expect(await respond(ghost.intro.intro_id, ghost.id, "decline")).toMatchObject({ kind: "declined" });
  });

  it("a double Accept (two taps at once) gives one success and one 'already answered', with one of everything", async () => {
    const alice = await pending();
    const tgBefore = net.tg.length;
    // Обидва натискання читають pending до того, як будь-яке з них запише: друге
    // впирається в сам пакет (статус уже не pending), і пакет відкочується цілком.
    const batch = db.d1.batch.bind(db.d1);
    const refused: string[] = [];
    vi.spyOn(db.d1, "batch").mockImplementation(async (statements) => {
      try {
        return await batch(statements);
      } catch (e) {
        refused.push((e as Error).message);
        throw e;
      }
    });
    const outcomes = await Promise.all([
      respond(alice.intro.intro_id, alice.id, "accept"),
      respond(alice.intro.intro_id, alice.id, "accept"),
    ]);
    expect(refused).toEqual(["NOT NULL constraint failed: intros.status"]);
    expect(outcomes.map((o) => o.kind).sort()).toEqual(["accepted", "answered"]);
    expect(answerText(outcomes.find((o) => o.kind === "answered")!)).toBe("You already answered this request.");
    expect(audit("intro.accept")).toHaveLength(1);
    expect(eventKinds(c.co, alice.id)).toEqual(["added", "intro_requested", "intro_accepted"]);
    expect(stageOf(c.co, alice.id).stage).toBe("contact_shared");
    expect(net.tg.slice(tgBefore).filter((m) => m.method === "sendMessage")).toHaveLength(1);
  });

  it("Accept and Decline at once: exactly one wins and the card matches it", async () => {
    const alice = await pending();
    const outcomes = await Promise.all([
      respond(alice.intro.intro_id, alice.id, "decline"),
      respond(alice.intro.intro_id, alice.id, "accept"),
    ]);
    const winner = outcomes.find((o) => o.kind === "accepted" || o.kind === "declined")!;
    expect(outcomes.filter((o) => o.kind === "answered")).toHaveLength(1);
    const row = introRow(alice.intro.intro_id);
    expect(row.status).toBe(winner.kind);
    expect(stageOf(c.co, alice.id).stage).toBe(winner.kind === "accepted" ? "contact_shared" : "declined");
  });
});

describe("decline", () => {
  it("declines, moves the card to declined by the candidate and does not notify the company", async () => {
    const alice = await pending();
    const tgBefore = net.tg.length;
    const outcome = await respond(alice.intro.intro_id, alice.id, "decline");
    expect(outcome).toEqual({ kind: "declined", companyName: "Acme Labs", blocked: false });
    expect(answerText(outcome)).toBe("Declined. Acme Labs will not contact you.");
    expect(introRow(alice.intro.intro_id)).toMatchObject({ status: "declined", candidate_blocked: 0, contact_value: null, respond_token_hash: null });
    expect(stageOf(c.co, alice.id)).toEqual({ stage: "declined", declined_by: "candidate" });
    expect(net.tg.length).toBe(tgBefore);
    // Кандидат досі видимий для компанії, але кулдаун 90 днів.
    expect(await isVisibleTo(db.d1, alice.id, c.co)).toBe(true);
    run(db.raw, "UPDATE pipeline SET stage = 'found', declined_by = NULL WHERE company_id = ?", c.co);
    expect(await rejection(ask(c.agent, alice.id))).toMatchObject({ code: "intro_cooldown" });
  });

  it("Decline and block hides the candidate from that company only; its card gets visibility_lost", async () => {
    const other = await addTestCompany(db, net, { name: "Other Labs" });
    const alice = addCandidate(db);
    const acmeIntro = (await ask(c.agent, alice.id)).output;
    await runAction("add_to_pipeline", { candidate_id: alice.id }, other.agent);

    const outcome = await respond(acmeIntro.intro_id, alice.id, "block");
    expect(outcome).toEqual({ kind: "declined", companyName: "Acme Labs", blocked: true });
    expect(answerText(outcome)).toBe("Declined. Acme Labs will not contact you again.");
    expect(introRow(acmeIntro.intro_id)).toMatchObject({ status: "declined", candidate_blocked: 1 });

    expect(stageOf(c.co, alice.id)).toEqual({ stage: "declined", declined_by: "candidate" });
    expect(eventKinds(c.co, alice.id)).toEqual(["added", "intro_requested", "intro_declined", "visibility_lost"]);
    expect(eventKinds(other.co, alice.id)).toEqual(["added"]);

    expect(await isVisibleTo(db.d1, alice.id, c.co)).toBe(false);
    expect(await isVisibleTo(db.d1, alice.id, other.co)).toBe(true);
    const acmeSearch = await searchCandidates(c.agent, {});
    const otherSearch = await searchCandidates(other.agent, {});
    expect(acmeSearch.data.map((d) => d.candidate_id)).not.toContain(alice.id);
    expect(otherSearch.data.map((d) => d.candidate_id)).toContain(alice.id);

    const card = (await runAction("list_pipeline", {}, c.agent)).output as { data: { visibility: string }[] };
    expect(card.data[0].visibility).toBe("hidden");
    expect(await rejection(ask(c.agent, alice.id))).toMatchObject({ code: "candidate_not_visible", status: 409 });
    expect((await ask(other.agent, alice.id)).output.status).toBe("pending");
    // Для компанії блок виглядає як невидимість: журнал каже visibility_lost, без слова «блок».
    expect(all(db.raw, "SELECT action FROM audit_log WHERE action LIKE 'pipeline.visibility%'")).toEqual([
      { action: "pipeline.visibility_lost" },
    ]);
  });
});

describe("answers after the fact", () => {
  it("another account or an unknown id changes nothing; withdrawn says so", async () => {
    const alice = await pending();
    const bob = addCandidate(db);
    const before = snapshot();
    expect(await respond(alice.intro.intro_id, bob.id, "accept")).toEqual({ kind: "not_yours" });
    expect(await respond("int_00000000000000000000", alice.id, "accept")).toEqual({ kind: "not_found" });
    expect(snapshot()).toEqual(before);

    await runAction("cancel_intro", { intro_id: alice.intro.intro_id }, c.agent);
    const withdrawn = await respond(alice.intro.intro_id, alice.id, "accept");
    expect(withdrawn).toEqual({ kind: "withdrawn" });
    expect(answerText(withdrawn)).toBe("This request was withdrawn.");
    expect(introRow(alice.intro.intro_id).status).toBe("canceled");
  });

  it("an answer after expires_at expires the intro there and then: card back to found, requester told once", async () => {
    const alice = await pending();
    const before = net.tg.length;
    const late = new Date("2026-09-27T12:00:00Z");
    expect(await respond(alice.intro.intro_id, alice.id, "accept", late)).toEqual({ kind: "expired" });
    expect(introRow(alice.intro.intro_id)).toMatchObject({ status: "expired", contact_value: null, respond_token_hash: null });
    expect(stageOf(c.co, alice.id).stage).toBe("found");
    expect(await respond(alice.intro.intro_id, alice.id, "accept", late)).toEqual({ kind: "expired" });
    const told = net.tg.slice(before).filter((m) => m.method === "sendMessage");
    expect(told.map((m) => String(m.payload.chat_id))).toEqual([c.ownerTelegram]);
    expect(String(told[0].payload.text)).toContain(`No answer from ${candidateLabel(alice.id)} in 14 days.`);
  });

  it("a suspended or closed company cannot receive the contact", async () => {
    const alice = await pending();
    run(db.raw, "UPDATE companies SET status = 'closed' WHERE id = ?", c.co);
    const before = snapshot();
    const outcome = await respond(alice.intro.intro_id, alice.id, "accept");
    expect(outcome).toEqual({ kind: "company_inactive" });
    expect(answerText(outcome)).toBe("This company can no longer receive contacts.");
    expect(snapshot()).toEqual(before);
    expect(await respond(alice.intro.intro_id, alice.id, "decline")).toMatchObject({ kind: "declined" });
  });
});

describe("the response page data (GET)", () => {
  it("shows exactly what will be shared, and never writes", async () => {
    const alice = addCandidate(db, { telegramId: null, email: "alice@gmail.com" });
    const res = await ask(c.agent, alice.id);
    const token = tokenFromMail(net.mail[0]);
    const before = snapshot();

    const view = await loadIntroForCandidate(db.d1, res.output.intro_id, { token, now: LATER });
    expect(view).toMatchObject({
      state: "pending",
      auth: "token",
      contact: { kind: "telegram", shown: "@alice_eth" },
      details: { companyName: "Acme Labs", message: res.output.message, expiresAt: "2026-09-26 12:00:00" },
    });
    // Той самий GET ще раз (сканер пошти): токен живий, нічого не записано.
    expect((await loadIntroForCandidate(db.d1, res.output.intro_id, { token, now: LATER })).state).toBe("pending");
    expect(snapshot()).toEqual(before);
  });

  it("masks the email when the email is what will be shared", async () => {
    const bob = addCandidate(db, { telegram: null, telegramId: null, email: "bob@gmail.com" });
    const res = await ask(c.agent, bob.id);
    const token = tokenFromMail(net.mail.at(-1)!);
    expect(await loadIntroForCandidate(db.d1, res.output.intro_id, { token, now: LATER })).toMatchObject({
      contact: { kind: "email", shown: "b***@gmail.com" },
    });
  });

  it("needs the right token or the candidate's own session", async () => {
    const alice = addCandidate(db, { telegramId: null });
    const res = await ask(c.agent, alice.id);
    const id = res.output.intro_id;
    const token = tokenFromMail(net.mail[0]);
    const wrong = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    expect(await loadIntroForCandidate(db.d1, id, { token: wrong, now: LATER })).toEqual({ state: "invalid" });
    expect(await loadIntroForCandidate(db.d1, id, { token: "short", now: LATER })).toEqual({ state: "invalid" });
    expect(await loadIntroForCandidate(db.d1, id, { sessionUserId: c.ownerId, now: LATER })).toEqual({ state: "invalid" });
    expect(await loadIntroForCandidate(db.d1, id, { sessionUserId: alice.id, now: LATER })).toMatchObject({ state: "pending", auth: "session" });
  });

  it("the token is single-use and ends with expires_at; states come before the token", async () => {
    const alice = addCandidate(db, { telegramId: null });
    const res = await ask(c.agent, alice.id);
    const id = res.output.intro_id;
    const token = tokenFromMail(net.mail[0]);
    await respond(id, alice.id, "decline");
    expect(await loadIntroForCandidate(db.d1, id, { token, now: LATER })).toEqual({ state: "answered" });
    expect(await authorizeCandidate(introRow(id) as { user_id: string; respond_token_hash: string | null }, { token })).toBeNull();

    // Після expires_at сторінка сама робить запит простроченим (картка → found).
    const bob = addCandidate(db, { telegramId: null });
    const second = await ask(c.agent, bob.id);
    const bobToken = tokenFromMail(net.mail.at(-1)!);
    expect(await loadIntroForCandidate(db.d1, second.output.intro_id, { token: bobToken, now: new Date("2026-09-26T12:00:01Z") })).toEqual({
      state: "expired",
    });
    expect(introRow(second.output.intro_id).status).toBe("expired");
    expect(stageOf(c.co, bob.id).stage).toBe("found");
  });

  it("a direct-mode reveal has nothing to answer", async () => {
    const d = addCandidate(db, { contactMode: "direct", contactConsent: true });
    const res = await ask(c.agent, d.id);
    expect(await loadIntroForCandidate(db.d1, res.output.intro_id, { sessionUserId: d.id, now: NOW })).toEqual({ state: "invalid" });
  });
});
