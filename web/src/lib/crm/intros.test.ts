import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/lib/auth/hash";
import { newId } from "@/lib/ids";
import { readX402Config } from "@/lib/x402/config";
import { clearResourceServerCache, createPaymentGate, type PaymentRequirementsSet } from "@/lib/x402/server";
import { addMember, addUsage, addUser, all, contextFor, crmDb, publishFormula, run, setConsent } from "@/test/crm-fixtures";
import {
  addCandidate,
  addTestCompany,
  ask,
  MESSAGE,
  NOW,
  rejection,
  stubNetwork,
  tokenFromMail,
  type Network,
  type TestCompany,
} from "@/test/intro-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import {
  commit,
  getAction,
  prepareAction,
  release,
  reserve,
  run as runHandler,
  runAction,
  type PreparedAction,
  type Reservation,
} from "./actions";
import type { ActionContext } from "./context";
import { findIntroByPayment, loadIntroForCandidate } from "./intros";
import { companyIntroNotice } from "./notify";
import { ActionError, type Intro } from "./types";

let db: TestDb;
let net: Network;

beforeEach(() => {
  clearResourceServerCache();
  db = crmDb();
  publishFormula(db.raw);
  net = stubNetwork();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const intros = () => all<Record<string, unknown>>(db.raw, "SELECT * FROM intros ORDER BY created_at, id");
const card = (co: string, user: string) =>
  all<{ stage: string; declined_by: string | null }>(db.raw, "SELECT stage, declined_by FROM pipeline WHERE company_id = ? AND user_id = ?", co, user)[0];
const events = (co: string, user: string) =>
  all<{ kind: string; from_stage: string | null; to_stage: string | null; actor_kind: string }>(
    db.raw,
    `SELECT e.kind, e.from_stage, e.to_stage, e.actor_kind FROM pipeline_events e JOIN pipeline p ON p.id = e.pipeline_id
      WHERE p.company_id = ? AND p.user_id = ? ORDER BY e.id`,
    co,
    user,
  );
const auditRows = () => all<{ actor: string; action: string; target: string | null }>(db.raw, "SELECT actor, action, target FROM audit_log ORDER BY id");

/** Уся база, що могла б змінитись: для перевірки «нічого не записано». */
function snapshot() {
  return {
    intros: all(db.raw, "SELECT * FROM intros"),
    pipeline: all(db.raw, "SELECT * FROM pipeline"),
    events: all(db.raw, "SELECT * FROM pipeline_events"),
    audit: all(db.raw, "SELECT * FROM audit_log"),
    usage: all(db.raw, "SELECT * FROM usage_events WHERE status BETWEEN 200 AND 299"),
  };
}

describe("request_intro in approval mode", () => {
  it("creates a pending intro for 14 days, moves the card, logs, counts and sends Telegram with three buttons", async () => {
    const c = await addTestCompany(db, net, { domain: "acme.io" });
    const alice = addCandidate(db);
    const res = await ask(c.agent, alice.id, { role: "engineer" });

    expect(res.status).toBe(201);
    expect(res.output).toMatchObject({
      status: "pending",
      mode: "approval",
      candidate_id: alice.id,
      role: "engineer",
      message: MESSAGE,
      requested_via: "rest",
      candidate_notified: true,
      contact: null,
      expires_at: "2026-09-26T12:00:00Z",
      responded_at: null,
    });
    const [row] = intros();
    expect(row).toMatchObject({ status: "pending", notify_channel: "telegram", notify_error: null, candidate_blocked: 0, contact_value: null });
    expect(row.respond_token_hash).toMatch(/^[0-9a-f]{64}$/);

    expect(card(c.co, alice.id)).toEqual({ stage: "intro_requested", declined_by: null });
    expect(events(c.co, alice.id)).toEqual([
      { kind: "added", from_stage: null, to_stage: "found", actor_kind: "agent" },
      { kind: "intro_requested", from_stage: "found", to_stage: "intro_requested", actor_kind: "agent" },
    ]);
    expect(auditRows().map((a) => [a.action, a.target])).toEqual([
      ["pipeline.add", alice.id],
      ["intro.request", alice.id],
      ["pipeline.stage", alice.id],
    ]);
    expect(all(db.raw, "SELECT action, status, billing FROM usage_events")).toEqual([
      { action: "request_intro", status: 201, billing: "included" },
    ]);

    const [sent] = net.messagesTo(alice.telegramId!);
    expect(sent.payload.parse_mode).toBe("HTML");
    expect(sent.payload.text).toBe(
      [
        "Acme Labs wants to talk to you about an Engineer role.",
        "",
        `&quot;${MESSAGE}&quot;`,
        "",
        "Company site: acme.io (domain verified)",
        "This request expires on Sep 26, 2026.",
        "",
        "If you accept, Acme Labs will see your Telegram handle @alice_eth. They will not see your email or wallets.",
      ].join("\n"),
    );
    expect(sent.payload.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: "Accept", callback_data: `ia:${res.output.intro_id}` },
          { text: "Decline", callback_data: `id:${res.output.intro_id}` },
        ],
        [{ text: "Decline and block this company", callback_data: `ib:${res.output.intro_id}` }],
      ],
    });
    expect(net.mail).toEqual([]);
  });

  it("falls back to email when the bot is blocked; the emailed link carries the one-time token whose hash is stored", async () => {
    const c = await addTestCompany(db, net);
    const alice = addCandidate(db, { email: "alice@gmail.com" });
    net.blockedChats.add(alice.telegramId!);
    const res = await ask(c.owner, alice.id);

    expect(res.output.candidate_notified).toBe(true);
    expect(net.mail).toHaveLength(1);
    const mail = net.mail[0];
    expect(mail).toMatchObject({ to: "alice@gmail.com", subject: "Acme Labs wants to talk to you" });
    expect(mail.text).toContain("Acme Labs wants to talk to you about a role.");
    expect(mail.text).toContain(`https://nextcryptojob.xyz/intro/${res.output.intro_id}?t=`);
    const token = tokenFromMail(mail);
    const [row] = intros();
    expect(row).toMatchObject({ notify_channel: "email", notify_error: null });
    expect(row.respond_token_hash).toBe(await sha256Hex(token));
    // Токен ніде не лежить відкрито.
    expect(JSON.stringify(snapshot())).not.toContain(token);
  });

  it("the Telegram request says which contact Accept will share: the handle, or the masked email", async () => {
    const c = await addTestCompany(db, net);
    const noHandle = addCandidate(db, { telegram: null, email: "bob.smith@proton.me" });
    await ask(c.agent, noHandle.id);
    expect(String(net.messagesTo(noHandle.telegramId!)[0].payload.text)).toContain(
      "If you accept, Acme Labs will see your email address b***@proton.me. They will not see your wallets.",
    );
    expect(String(net.messagesTo(noHandle.telegramId!)[0].payload.text)).not.toContain("bob.smith");
    const nothing = addCandidate(db, { telegram: null, email: null });
    await ask(c.agent, nothing.id);
    expect(String(net.messagesTo(nothing.telegramId!)[0].payload.text)).toContain(
      "Add a Telegram username or an email to your account first, then accept.",
    );
    // Те, що обіцяно, і відкривається.
    const intro = all<{ id: string }>(db.raw, "SELECT id FROM intros WHERE user_id = ?", noHandle.id)[0];
    const { respondToIntro } = await import("./intros");
    await respondToIntro(db.d1, {
      introId: intro.id,
      userId: noHandle.id,
      decision: "accept",
      via: "telegram",
      notifier: { mailer: null, origin: "https://nextcryptojob.xyz" },
    });
    expect(all(db.raw, "SELECT contact_kind, contact_value FROM intros WHERE id = ?", intro.id)).toEqual([
      { contact_kind: "email", contact_value: "bob.smith@proton.me" },
    ]);
  });

  it("a candidate whose channel is email gets the email first, with Telegram as the fallback", async () => {
    const c = await addTestCompany(db, net);
    const alice = addCandidate(db, { channel: "email" });
    net.mailFails = true;
    const res = await ask(c.agent, alice.id);
    expect(res.output.candidate_notified).toBe(true);
    expect(intros()[0]).toMatchObject({ notify_channel: "telegram" });
    expect(net.messagesTo(alice.telegramId!)).toHaveLength(1);
  });

  it("when neither channel works the intro still lives, notify_error says why and the company sees that the candidate was not reached", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const c = await addTestCompany(db, net, { env: { EMAIL: undefined } });
    const alice = addCandidate(db);
    net.blockedChats.add(alice.telegramId!);
    const res = await ask(c.agent, alice.id);

    expect(res.output).toMatchObject({ status: "pending", candidate_notified: false });
    const [row] = intros();
    expect(row.notify_channel).toBeNull();
    expect(row.notified_at).toBeNull();
    expect(row.notify_error).toBe("telegram: Forbidden: bot was blocked by the user; email: not configured: EMAIL");
    expect(card(c.co, alice.id).stage).toBe("intro_requested");
    const status = await runAction("intro_status", { intro_id: res.output.intro_id }, c.agent);
    expect((status.output as Intro).candidate_notified).toBe(false);
    // Компанія бачить, що кандидата не вдалося сповістити; сповіщеному запиту плашка не потрібна.
    expect(companyIntroNotice(status.output as Intro)).toBe("We could not reach the candidate yet.");
    vi.unstubAllEnvs();
    const reached = await ask((await addTestCompany(db, net, { name: "Reached" })).agent, addCandidate(db).id);
    expect(companyIntroNotice(reached.output)).toBeNull();
  });

  it("a failing email binding is recorded without the address", async () => {
    const c = await addTestCompany(db, net);
    const alice = addCandidate(db, { telegramId: null });
    net.mailFails = true;
    await ask(c.agent, alice.id);
    const [row] = intros();
    expect(row.notify_error).toBe("email: E_RECIPIENT_SUPPRESSED: delivery to [email] refused");
  });

  it("shows the linked job and the agency's client to the candidate", async () => {
    const c = await addTestCompany(db, net, { name: "Hire & Co", kind: "agency" });
    const job = newId("job");
    run(
      db.raw,
      `INSERT INTO company_jobs (id, company_id, status, title, roles, apply_url, expires_at, created_via)
       VALUES (?, ?, 'open', 'Solidity <engineer>', '["engineer"]', 'https://acme.io/apply', datetime('now', '+30 days'), 'web')`,
      job,
      c.co,
    );
    const alice = addCandidate(db);
    const res = await ask(c.agent, alice.id, { job_id: job, hiring_for: "Confidential client" });
    expect(res.output).toMatchObject({ job_id: job, hiring_for: "Confidential client", role: "engineer" });
    const text = String(net.messagesTo(alice.telegramId!)[0].payload.text);
    expect(text).toContain("Hire &amp; Co wants to talk to you about an Engineer role.");
    expect(text).toContain("Hiring for: Confidential client");
    expect(text).toContain(
      `Job: Solidity &lt;engineer&gt; (<a href="https://nextcryptojob.xyz/jobs/${job}">nextcryptojob.xyz/jobs/${job}</a>)`,
    );
  });
});

describe("request_intro in direct mode", () => {
  it("returns the Telegram handle at once, moves the card to contact_shared and tells the candidate who looked", async () => {
    const c = await addTestCompany(db, net);
    const alice = addCandidate(db, { contactMode: "direct", contactConsent: true, telegram: "@alice_eth " });
    const res = await ask(c.agent, alice.id);

    expect(res.status).toBe(201);
    expect(res.output).toMatchObject({
      status: "direct",
      mode: "direct",
      contact: { kind: "telegram", value: "@alice_eth", via: "direct", shared_at: "2026-09-12T12:00:00Z" },
    });
    expect(intros()[0]).toMatchObject({ respond_token_hash: null, contact_kind: "telegram", contact_value: "@alice_eth" });
    expect(card(c.co, alice.id).stage).toBe("contact_shared");
    expect(auditRows().map((a) => a.action)).toEqual(["pipeline.add", "contact.reveal", "pipeline.stage"]);
    const [sent] = net.messagesTo(alice.telegramId!);
    expect(sent.payload.text).toBe("Acme Labs viewed your Telegram handle.");
    expect(sent.payload.reply_markup).toBeUndefined();
  });

  it("falls back to approval without a handle or without the contact consent", async () => {
    const c = await addTestCompany(db, net);
    const noHandle = addCandidate(db, { contactMode: "direct", contactConsent: true, telegram: null });
    const noConsent = addCandidate(db, { contactMode: "direct", contactConsent: false });
    const revoked = addCandidate(db, { contactMode: "direct", contactConsent: true });
    setConsent(db.raw, revoked.id, "contact", false);
    for (const who of [noHandle, noConsent, revoked]) {
      const res = await ask(c.agent, who.id);
      expect(res.output).toMatchObject({ status: "pending", mode: "approval", contact: null });
    }
  });
});

describe("request_intro checks, all before anything is written", () => {
  let c: TestCompany;
  beforeEach(async () => {
    c = await addTestCompany(db, net);
  });

  async function refused(ctx: ActionContext, input: Record<string, unknown>) {
    const before = snapshot();
    const tgBefore = net.tg.length;
    const err = await rejection(runAction("request_intro", { message: MESSAGE, ...input }, ctx));
    expect(snapshot()).toEqual(before);
    expect(net.tg.length).toBe(tgBefore);
    return err;
  }

  it("a hidden candidate: 404 when not in the pipeline, 409 candidate_not_visible when the card is there", async () => {
    const hidden = addCandidate(db, { visible: false });
    expect(await refused(c.agent, { candidate_id: hidden.id })).toMatchObject({ code: "candidate_not_available", status: 404 });

    const later = addCandidate(db);
    await runAction("add_to_pipeline", { candidate_id: later.id }, c.agent);
    run(db.raw, "UPDATE users SET visible_to_companies = 0 WHERE id = ?", later.id);
    expect(await refused(c.agent, { candidate_id: later.id })).toMatchObject({ code: "candidate_not_visible", status: 409 });

    // Згоду відкликано: так само невидимий.
    const noConsent = addCandidate(db);
    setConsent(db.raw, noConsent.id, "visibility", false);
    expect(await refused(c.agent, { candidate_id: noConsent.id })).toMatchObject({ code: "candidate_not_available" });
    // Неіснуючий id.
    expect(await refused(c.agent, { candidate_id: crypto.randomUUID() })).toMatchObject({ code: "candidate_not_available" });
  });

  it("a teammate of the company is invisible to it", async () => {
    const mate = addCandidate(db);
    addMember(db.raw, c.co, mate.id, "member");
    expect(await refused(c.agent, { candidate_id: mate.id })).toMatchObject({ code: "candidate_not_available", status: 404 });
  });

  it("one open intro per candidate: intro_already_open names it", async () => {
    const alice = addCandidate(db);
    const first = await ask(c.agent, alice.id);
    expect(await refused(c.owner, { candidate_id: alice.id })).toMatchObject({
      code: "intro_already_open",
      status: 409,
      details: { intro_id: first.output.intro_id },
    });
  });

  it("no new request for 90 days after a decline: intro_cooldown with retry_after", async () => {
    const alice = addCandidate(db);
    const first = await ask(c.agent, alice.id);
    run(db.raw, "UPDATE intros SET status = 'declined', responded_at = '2026-09-10 08:00:00' WHERE id = ?", first.output.intro_id);
    run(db.raw, "UPDATE pipeline SET stage = 'found' WHERE company_id = ?", c.co);
    const err = await refused(c.agent, { candidate_id: alice.id });
    expect(err).toMatchObject({ code: "intro_cooldown", status: 409, details: { retry_after: "2026-12-09T08:00:00Z" } });
    expect(err.message).toBe("This candidate declined your last intro request. Try again after Dec 9, 2026.");
    // Відмова понад 90 днів тому не заважає.
    run(db.raw, "UPDATE intros SET responded_at = '2026-06-01 08:00:00', created_at = '2026-06-01 08:00:00' WHERE id = ?", first.output.intro_id);
    expect((await ask(c.agent, alice.id)).output.status).toBe("pending");
  });

  it("at most 2 requests per candidate in 90 days, whatever became of them", async () => {
    const alice = addCandidate(db);
    const cancelAt = async (created: string) => {
      const res = await ask(c.agent, alice.id);
      await runAction("cancel_intro", { intro_id: res.output.intro_id }, c.agent);
      run(db.raw, "UPDATE intros SET created_at = ? WHERE id = ?", created, res.output.intro_id);
    };
    await cancelAt("2026-08-01 10:00:00");
    await cancelAt("2026-09-01 10:00:00");
    const err = await refused(c.agent, { candidate_id: alice.id });
    // Друге найновіше (1 серпня) + 90 днів.
    expect(err).toMatchObject({ code: "intro_cooldown", details: { retry_after: "2026-10-30T10:00:00Z" } });
    expect(err.message).toBe(
      "You can send at most 2 intro requests to one candidate in 90 days. Try again after Oct 30, 2026.",
    );
    // Інша компанія має свій лічильник.
    const other = await addTestCompany(db, net, { name: "Other" });
    expect((await ask(other.agent, alice.id)).output.status).toBe("pending");
  });

  it("the daily quota: 429 before the intro exists", async () => {
    const alice = addCandidate(db);
    addUsage(db.raw, 10, { companyId: c.co, action: "request_intro", at: "2026-09-12 08:00:00" });
    const before = all(db.raw, "SELECT * FROM intros");
    const err = await rejection(ask(c.agent, alice.id));
    expect(err).toMatchObject({ code: "daily_quota_exceeded", status: 429 });
    expect(all(db.raw, "SELECT * FROM intros")).toEqual(before);
    expect(net.tg).toEqual([]);
  });

  it("the message is 20 to 600 characters without the blanks around it", async () => {
    const alice = addCandidate(db);
    expect(await refused(c.agent, { candidate_id: alice.id, message: `   ${"x".repeat(19)}     ` })).toMatchObject({
      code: "validation_failed",
      status: 422,
      details: { fields: { message: "Write at least 20 characters." } },
    });
    expect(await refused(c.agent, { candidate_id: alice.id, message: "x".repeat(601) })).toMatchObject({ code: "validation_failed" });
    expect(await refused(c.agent, { candidate_id: alice.id, message: "too short" })).toMatchObject({ code: "validation_failed" });
  });

  it("job_id must be one of the company's own open jobs", async () => {
    const alice = addCandidate(db);
    const other = await addTestCompany(db, net, { name: "Other" });
    const job = (companyId: string, status: string) => {
      const id = newId("job");
      run(
        db.raw,
        `INSERT INTO company_jobs (id, company_id, status, title, apply_url, expires_at, created_via)
         VALUES (?, ?, ?, 'Solidity engineer', 'https://x.io', datetime('now', '+30 days'), 'web')`,
        id,
        companyId,
        status,
      );
      return id;
    };
    expect(await refused(c.agent, { candidate_id: alice.id, job_id: job(other.co, "open") })).toMatchObject({ code: "not_found", status: 404 });
    expect(await refused(c.agent, { candidate_id: alice.id, job_id: job(c.co, "draft") })).toMatchObject({
      code: "validation_failed",
      details: { fields: { job_id: "Link one of your open jobs." } },
    });
    expect(await refused(c.agent, { candidate_id: alice.id, job_id: job(c.co, "closed") })).toMatchObject({ code: "validation_failed" });
    const hidden = job(c.co, "open");
    run(db.raw, "UPDATE company_jobs SET hidden_by_admin_at = datetime('now') WHERE id = ?", hidden);
    expect(await refused(c.agent, { candidate_id: alice.id, job_id: hidden })).toMatchObject({
      code: "validation_failed",
      details: { fields: { job_id: "Link one of your open jobs." } },
    });
  });

  it("agencies must say who they are hiring for; companies do not pass it on", async () => {
    const agency = await addTestCompany(db, net, { name: "Hire Co", kind: "agency" });
    const alice = addCandidate(db);
    expect(await refused(agency.agent, { candidate_id: alice.id })).toMatchObject({
      code: "validation_failed",
      details: { fields: { hiring_for: 'Agencies must say who they are hiring for, or write "Confidential client".' } },
    });
    expect(await refused(agency.agent, { candidate_id: alice.id, hiring_for: "  " })).toMatchObject({ code: "validation_failed" });
    const own = await ask(c.agent, alice.id, { hiring_for: "Someone else" });
    expect(own.output.hiring_for).toBeNull();
  });

  it("a card past found needs to be moved back first (approval mode)", async () => {
    const alice = addCandidate(db);
    await runAction("add_to_pipeline", { candidate_id: alice.id }, c.agent);
    run(db.raw, "UPDATE pipeline SET stage = 'declined', declined_by = 'company' WHERE company_id = ?", c.co);
    expect(await refused(c.agent, { candidate_id: alice.id })).toMatchObject({ code: "invalid_stage_transition", status: 409 });
  });
});

describe("paid request_intro (company without a subscription, settle before effect)", () => {
  const RESOURCE = { url: "https://nextcryptojob.xyz/api/v1/intros", description: "NextCryptoJob intro request" };
  let nonce = 0;

  function evmPayment(set: PaymentRequirementsSet, paymentIdentifier?: string): PaymentPayload {
    nonce++;
    return {
      x402Version: 2,
      resource: set.resource,
      accepted: set.accepts[0],
      ...(paymentIdentifier ? { extensions: { "payment-identifier": { info: { required: false, id: paymentIdentifier } } } } : {}),
      payload: {
        signature: `0x${nonce.toString(16).padStart(130, "0")}`,
        authorization: {
          from: "0x2222222222222222222222222222222222222222",
          to: set.accepts[0].payTo,
          value: set.accepts[0].amount,
          validAfter: "0",
          validBefore: "9999999999",
          nonce: `0x${nonce.toString(16).padStart(64, "0")}`,
        },
      },
    };
  }

  async function signedPayment(ctx: ActionContext, paymentIdentifier?: string): Promise<string> {
    const gate = createPaymentGate({ db: db.d1, config: readX402Config(ctx.env, "development") });
    return encodePaymentSignatureHeader(evmPayment(await gate.requirementsFor("request_intro", RESOURCE), paymentIdentifier));
  }

  /** Той самий порядок, що в маршруті REST: prepare → reserve (validate) → settle → run → commit. */
  async function paidCall(prepared: PreparedAction, payment?: string) {
    const gate = createPaymentGate({ db: db.d1, config: readX402Config(prepared.ctx.env, "development") });
    const set = await gate.requirementsFor(prepared.payment!.action, RESOURCE);
    let reservation: Reservation | undefined;
    const paid = gate.withPayment<Awaited<ReturnType<typeof runHandler>>, ActionError>("request_intro", "before_effect", {
      validate: async (p) => {
        try {
          reservation = await reserve(prepared, { id: p.paymentId, payer: p.payer });
        } catch (e) {
          if (e instanceof ActionError) return e;
          throw e;
        }
      },
      effect: () => runHandler(prepared),
    });
    const out = await paid({
      payment: payment ?? encodePaymentSignatureHeader(evmPayment(set)),
      input: prepared.input,
      resource: RESOURCE,
      context: { channel: "rest", companyId: prepared.ctx.company?.id ?? null },
    });
    if (out.kind === "ok") return { out, result: await commit(reservation!, out.value) };
    if (reservation) await release(reservation, 402);
    return { out, result: null };
  }

  it("a refused check (not visible, cooldown, open intro) settles nothing and frees the payment", async () => {
    const c = await addTestCompany(db, net, { subscribed: false });
    const sub = await addTestCompany(db, net, { name: "Subscribed" });
    const hidden = addCandidate(db, { visible: false });
    const declined = addCandidate(db);
    const first = (await ask(sub.agent, declined.id)).output;
    run(db.raw, "UPDATE intros SET company_id = ?, status = 'declined', responded_at = '2026-09-10 08:00:00' WHERE id = ?", c.co, first.intro_id);
    const open = addCandidate(db);
    const openIntro = (await ask(sub.agent, open.id)).output;
    run(db.raw, "UPDATE intros SET company_id = ? WHERE id = ?", c.co, openIntro.intro_id);
    run(db.raw, "INSERT INTO pipeline (company_id, user_id, stage, added_via) VALUES (?, ?, 'intro_requested', 'rest')", c.co, open.id);

    const cases: [string, string][] = [
      [hidden.id, "candidate_not_available"],
      [declined.id, "intro_cooldown"],
      [open.id, "intro_already_open"],
    ];
    const introsBefore = all(db.raw, "SELECT * FROM intros");
    for (const [candidate, code] of cases) {
      const verifyBefore = net.verify;
      const prepared = prepareAction("request_intro", { candidate_id: candidate, message: MESSAGE }, c.agent);
      expect(prepared.payment).toMatchObject({ usd: "5.00", settle: "before_effect" });
      const { out } = await paidCall(prepared);
      expect(out).toMatchObject({ kind: "rejected", error: { code } });
      expect(net.verify).toBe(verifyBefore + 1);
    }
    expect(net.settle).toBe(0);
    expect(all(db.raw, "SELECT id FROM x402_payments")).toEqual([]);
    expect(all(db.raw, "SELECT * FROM usage_events WHERE company_id = ?", c.co)).toEqual([]);
    expect(all(db.raw, "SELECT * FROM intros")).toEqual(introsBefore);
  });

  it("two concurrent paid requests for the same pair with different payments settle exactly once", async () => {
    const c = await addTestCompany(db, net, { subscribed: false });
    const alice = addCandidate(db);
    // Обидві перевірки проходять раніше за будь-яку бронь: друга впирається саме в бронь пари.
    const def = getAction("request_intro")!;
    const original = def.precheck!;
    let passed = 0;
    let bothPassed!: () => void;
    const barrier = new Promise<void>((resolve) => (bothPassed = resolve));
    def.precheck = async (ctx, input) => {
      await original(ctx, input);
      if (++passed === 2) bothPassed();
      await barrier;
    };
    try {
      const a = prepareAction("request_intro", { candidate_id: alice.id, message: MESSAGE }, c.agent);
      const b = prepareAction("request_intro", { candidate_id: alice.id, message: `${MESSAGE} (retry)` }, c.agent);
      const [pa, pb] = [await signedPayment(c.agent), await signedPayment(c.agent)];
      const outs = await Promise.all([paidCall(a, pa), paidCall(b, pb)]);
      expect(passed).toBe(2);
      expect(outs.map((o) => o.out.kind).sort()).toEqual(["ok", "rejected"]);
      expect(outs.find((o) => o.out.kind === "rejected")!.out).toMatchObject({
        kind: "rejected",
        error: { code: "intro_already_open", status: 409 },
      });
    } finally {
      def.precheck = original;
    }
    expect(net.settle).toBe(1);
    expect(all(db.raw, "SELECT status FROM x402_payments")).toEqual([{ status: "settled" }]);
    expect(all(db.raw, "SELECT status FROM intros")).toEqual([{ status: "pending" }]);
    expect(all(db.raw, "SELECT status FROM usage_events WHERE company_id = ?", c.co)).toEqual([{ status: 201 }]);
    expect(net.messagesTo(alice.telegramId!)).toHaveLength(1);
  });

  it("while a paid request holds the pair, the candidate sees nothing and a cancelled payment frees the pair", async () => {
    const c = await addTestCompany(db, net, { subscribed: false });
    const alice = addCandidate(db);
    const prepared = prepareAction("request_intro", { candidate_id: alice.id, message: MESSAGE }, c.agent);
    net.settleOk = false;
    const { out } = await paidCall(prepared);
    expect(out.kind).toBe("payment_required");
    // Settle не пройшов: бронь знято, нікого не сповіщено, пара вільна.
    expect(all(db.raw, "SELECT * FROM intros")).toEqual([]);
    expect(net.messagesTo(alice.telegramId!)).toEqual([]);
    net.settleOk = true;
    const again = await paidCall(prepareAction("request_intro", { candidate_id: alice.id, message: MESSAGE }, c.agent));
    expect(again.out.kind).toBe("ok");
  });

  it("a replay of the same payment and payment-identifier returns the stored intro, with no second intro or message", async () => {
    const c = await addTestCompany(db, net, { subscribed: false });
    const alice = addCandidate(db);
    const payment = await signedPayment(c.agent, "intro_retry_0123456789");
    const input = { candidate_id: alice.id, message: MESSAGE };
    const first = await paidCall(prepareAction("request_intro", input, c.agent), payment);
    expect(first.out.kind).toBe("ok");
    const introId = (first.result!.output as Intro).intro_id;

    const replay = await paidCall(prepareAction("request_intro", input, c.agent), payment);
    expect(replay.out.kind).toBe("replay");
    if (replay.out.kind !== "replay") throw new Error("expected a replay");
    const stored = await findIntroByPayment(db.d1, c.co, replay.out.payment.id);
    expect(stored).toMatchObject({ intro_id: introId, status: "pending" });
    expect(net.settle).toBe(1);
    expect(all(db.raw, "SELECT id FROM intros")).toEqual([{ id: introId }]);
    expect(net.messagesTo(alice.telegramId!)).toHaveLength(1);
  });

  it("without a payment the unpaid path learns about a refused check before any 402", async () => {
    const c = await addTestCompany(db, net, { subscribed: false });
    const hidden = addCandidate(db, { visible: false });
    const err = await rejection(runAction("request_intro", { candidate_id: hidden.id, message: MESSAGE }, c.agent));
    expect(err).toMatchObject({ code: "candidate_not_available" });
  });

  it("a settled payment creates the intro with the payment id, bills x402 and can be found again by the payment", async () => {
    const c = await addTestCompany(db, net, { subscribed: false });
    const alice = addCandidate(db);
    const prepared = prepareAction("request_intro", { candidate_id: alice.id, message: MESSAGE }, c.agent);
    const { out, result } = await paidCall(prepared);
    expect(out.kind).toBe("ok");
    expect(net.settle).toBe(1);
    const [pay] = all<{ id: string; status: string }>(db.raw, "SELECT id, status FROM x402_payments");
    expect(pay.status).toBe("settled");
    expect(intros()[0]).toMatchObject({ x402_payment_id: pay.id, status: "pending" });
    expect(result!.status).toBe(201);
    expect(all(db.raw, "SELECT action, billing, status, x402_payment_id FROM usage_events")).toEqual([
      { action: "request_intro", billing: "x402", status: 201, x402_payment_id: pay.id },
    ]);
    expect(await findIntroByPayment(db.d1, c.co, pay.id)).toMatchObject({ intro_id: (result!.output as Intro).intro_id });
    expect(await findIntroByPayment(db.d1, "co_other", pay.id)).toBeNull();
    // Сповіщення пішло ПІСЛЯ settle.
    expect(net.messagesTo(alice.telegramId!)).toHaveLength(1);
  });

  it("the web app does not take x402: a company without a subscription is told to subscribe", async () => {
    const c = await addTestCompany(db, net, { subscribed: false });
    const alice = addCandidate(db);
    expect(await rejection(ask(c.owner, alice.id))).toMatchObject({ code: "subscription_required", status: 403 });
  });
});

describe("expiry without a scheduler", () => {
  it("after expires_at the company sees expired, gets one message, and can ask again", async () => {
    const c = await addTestCompany(db, net);
    const alice = addCandidate(db);
    const first = (await ask(c.agent, alice.id)).output;
    const late = { ...c.agent, now: new Date("2026-09-27T09:00:00Z") };
    const toOwner = () => net.messagesTo(c.ownerTelegram);

    const status = (await runAction("intro_status", { intro_id: first.intro_id }, late)).output as Intro;
    expect(status.status).toBe("expired");
    expect(card(c.co, alice.id).stage).toBe("found");
    expect(toOwner()).toHaveLength(1);
    expect(String(toOwner()[0].payload.text)).toContain("in 14 days.");

    // Ще одне читання: вже expired, другого повідомлення немає.
    const list = (await runAction("list_intros", {}, late)).output as { data: Intro[] };
    expect(list.data.map((i) => i.status)).toEqual(["expired"]);
    expect(toOwner()).toHaveLength(1);

    const again = await ask(late, alice.id);
    expect(again.output.status).toBe("pending");
    expect(card(c.co, alice.id).stage).toBe("intro_requested");
  });

  it("a new request after expires_at expires the old one first, without anyone reading it", async () => {
    const c = await addTestCompany(db, net);
    const alice = addCandidate(db);
    const first = (await ask(c.agent, alice.id)).output;
    const again = await ask({ ...c.agent, now: new Date("2026-09-27T09:00:00Z") }, alice.id);
    expect(again.output.status).toBe("pending");
    expect(all(db.raw, "SELECT id, status FROM intros ORDER BY created_at")).toEqual([
      { id: first.intro_id, status: "expired" },
      { id: again.output.intro_id, status: "pending" },
    ]);
  });
});

describe("the pair hold", () => {
  it("direct mode shares the handle the candidate has at the moment of writing", async () => {
    const c = await addTestCompany(db, net);
    const alice = addCandidate(db, { contactMode: "direct", contactConsent: true, telegram: "old_handle" });
    const def = getAction("request_intro")!;
    const original = def.precheck!;
    def.precheck = async (ctx, input) => {
      await original(ctx, input);
      run(db.raw, "UPDATE users SET telegram_username = 'new_handle' WHERE id = ?", alice.id);
    };
    try {
      const res = await ask(c.agent, alice.id);
      expect(res.output.contact).toMatchObject({ kind: "telegram", value: "@new_handle" });
    } finally {
      def.precheck = original;
    }
  });

  it("a dead hold (process died before the write) does not block the pair for long", async () => {
    const c = await addTestCompany(db, net);
    const alice = addCandidate(db);
    run(
      db.raw,
      `INSERT INTO intros (id, company_id, user_id, mode, status, message, requested_via, expires_at, created_at, updated_at)
       VALUES ('int_DEADHOLDDEADHOLD000', ?, ?, 'approval', 'pending', 'held by a request that died', 'rest',
               '2026-09-26 11:00:00', '2026-09-12 11:00:00', '2026-09-12 11:00:00')`,
      c.co,
      alice.id,
    );
    // Бронь не видно ні компанії, ні кандидату.
    expect((await runAction("list_intros", {}, c.agent)).output).toEqual({ data: [], next_cursor: null });
    expect(await loadIntroForCandidate(db.d1, "int_DEADHOLDDEADHOLD000", { sessionUserId: alice.id, now: NOW })).toEqual({
      state: "invalid",
    });
    // Бронь з 11:00 о 12:00 старша за 10 хв, тож мертва: новий запит проходить.
    const res = await ask(c.agent, alice.id);
    expect(res.output.status).toBe("pending");
    expect(all(db.raw, "SELECT id FROM intros")).toEqual([{ id: res.output.intro_id }]);
  });

  it("a live hold refuses a second request with intro_already_open before anything is paid", async () => {
    const c = await addTestCompany(db, net);
    const alice = addCandidate(db);
    run(
      db.raw,
      `INSERT INTO intros (id, company_id, user_id, mode, status, message, requested_via, expires_at, created_at, updated_at)
       VALUES ('int_LIVEHOLDLIVEHOLD00', ?, ?, 'approval', 'pending', 'held by a request in flight', 'rest',
               '2026-09-26 11:59:00', '2026-09-12 11:59:00', '2026-09-12 11:59:00')`,
      c.co,
      alice.id,
    );
    expect(await rejection(ask(c.agent, alice.id))).toMatchObject({ code: "intro_already_open", status: 409 });
    expect(net.tg).toEqual([]);
  });
});

describe("cancel_intro", () => {
  it("withdraws a pending intro: canceled, card back to found, token gone, logged; the candidate's link says withdrawn", async () => {
    const c = await addTestCompany(db, net);
    const alice = addCandidate(db, { telegramId: null });
    const res = await ask(c.agent, alice.id);
    const token = tokenFromMail(net.mail[0]);

    const canceled = await runAction("cancel_intro", { intro_id: res.output.intro_id }, c.owner);
    expect(canceled.output).toMatchObject({ status: "canceled", intro_id: res.output.intro_id });
    expect(intros()[0]).toMatchObject({ status: "canceled", respond_token_hash: null });
    expect(card(c.co, alice.id).stage).toBe("found");
    expect(events(c.co, alice.id).at(-1)).toEqual({ kind: "intro_canceled", from_stage: "intro_requested", to_stage: "found", actor_kind: "member" });
    expect(auditRows().slice(-2).map((a) => [a.actor, a.action])).toEqual([
      [`${c.co}:member:${c.ownerId}`, "intro.cancel"],
      [`${c.co}:member:${c.ownerId}`, "pipeline.stage"],
    ]);
    expect(await loadIntroForCandidate(db.d1, res.output.intro_id, { token, now: NOW })).toEqual({ state: "withdrawn" });

    expect(await rejection(runAction("cancel_intro", { intro_id: res.output.intro_id }, c.agent))).toMatchObject({
      code: "intro_not_pending",
      status: 409,
    });
  });
});

describe("tenant isolation", () => {
  it("another company cannot read, list or cancel this company's intros", async () => {
    const acme = await addTestCompany(db, net);
    const other = await addTestCompany(db, net, { name: "Other Labs" });
    const alice = addCandidate(db);
    const res = await ask(acme.agent, alice.id);
    const id = res.output.intro_id;

    expect(await rejection(runAction("intro_status", { intro_id: id }, other.agent))).toMatchObject({ code: "not_found", status: 404 });
    expect(await rejection(runAction("cancel_intro", { intro_id: id }, other.owner))).toMatchObject({ code: "not_found", status: 404 });
    expect((await runAction("list_intros", {}, other.agent)).output).toEqual({ data: [], next_cursor: null });
    expect(intros()[0].status).toBe("pending");
    // Своя компанія бачить.
    expect((await runAction("intro_status", { intro_id: id }, acme.owner)).output).toMatchObject({ intro_id: id, status: "pending" });
  });
});

describe("list_intros", () => {
  it("newest change first, filters by status and updated_since, pages with a cursor", async () => {
    const c = await addTestCompany(db, net);
    const people = [addCandidate(db), addCandidate(db), addCandidate(db)];
    const ids: string[] = [];
    for (const [i, p] of people.entries()) {
      const res = await ask({ ...c.agent, now: new Date(NOW.getTime() + i * 60_000) }, p.id);
      ids.push(res.output.intro_id);
    }
    await runAction("cancel_intro", { intro_id: ids[0] }, { ...c.agent, now: new Date(NOW.getTime() + 10 * 60_000) });

    const list = async (input: Record<string, unknown>) =>
      (await runAction("list_intros", input, c.agent)).output as { data: Intro[]; next_cursor: string | null };
    expect((await list({})).data.map((i) => i.intro_id)).toEqual([ids[0], ids[2], ids[1]]);
    expect((await list({ status: "pending" })).data.map((i) => i.intro_id)).toEqual([ids[2], ids[1]]);
    expect((await list({ updated_since: "2026-09-12T12:01:30Z" })).data.map((i) => i.intro_id)).toEqual([ids[0], ids[2]]);

    const page1 = await list({ limit: 2 });
    expect(page1.data.map((i) => i.intro_id)).toEqual([ids[0], ids[2]]);
    const page2 = await list({ limit: 2, cursor: page1.next_cursor });
    expect(page2).toMatchObject({ next_cursor: null });
    expect(page2.data.map((i) => i.intro_id)).toEqual([ids[1]]);
    expect(await rejection(list({ cursor: "bm9wZQ" }))).toMatchObject({ code: "validation_failed" });
  });
});

describe("who can request", () => {
  it("members of another company or strangers cannot; an agent of the company can", async () => {
    const c = await addTestCompany(db, net);
    const alice = addCandidate(db);
    const stranger = addUser(db.raw, { visible: false });
    expect(await rejection(contextFor(db, { sessionUserId: stranger }))).toMatchObject({ code: "unauthorized", status: 401 });
    expect((await ask(c.agent, alice.id)).output.requested_via).toBe("rest");
    expect(intros()[0]).toMatchObject({ requested_by_key_id: c.keyId, requested_by_user_id: null });
  });
});
