import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, SESSION_COOKIE } from "@/lib/auth/session";
import { runAction } from "@/lib/crm/actions";
import { publishFormula } from "@/test/crm-fixtures";
import { harness, resetHarness, rows } from "@/test/harness";
import { addCandidate, addTestCompany, ask, fakeEmail, stubNetwork, tokenFromMail, type Network, type TestCompany } from "@/test/intro-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { answerIntroAction } from "./actions";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/navigation", async () => (await import("@/test/harness")).navigationModule);

let net: Network;
let db: TestDb;
let c: TestCompany;

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

beforeEach(async () => {
  net = stubNetwork();
  resetHarness({ EMAIL: fakeEmail(net) });
  db = { raw: harness.raw, d1: harness.env.DB };
  publishFormula(db.raw);
  c = await addTestCompany(db, net);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Кандидат без Telegram-чату: запит іде листом з токеном. */
async function emailed() {
  const alice = addCandidate(db, { telegramId: null });
  const intro = (await ask(c.agent, alice.id)).output;
  return { ...alice, introId: intro.intro_id, token: tokenFromMail(net.mail.at(-1)!) };
}

const statusOf = (id: string) => rows<{ status: string }>("SELECT status FROM intros WHERE id = ?", id)[0].status;

describe("answerIntroAction (POST from /intro/[id])", () => {
  it("accepts with the emailed token, once: the same token again only hears 'already answered'", async () => {
    const alice = await emailed();
    const res = await answerIntroAction({}, form({ intro_id: alice.introId, t: alice.token, decision: "accept" }));
    expect(res).toEqual({ done: true, tone: "success", text: "Done. Acme Labs can now see your Telegram handle." });
    expect(statusOf(alice.introId)).toBe("accepted");
    expect(rows("SELECT respond_token_hash FROM intros WHERE id = ?", alice.introId)).toEqual([{ respond_token_hash: null }]);

    const again = await answerIntroAction({}, form({ intro_id: alice.introId, t: alice.token, decision: "decline" }));
    expect(again).toEqual({ done: true, tone: "info", text: "You already answered this request." });
    expect(statusOf(alice.introId)).toBe("accepted");
  });

  it("a wrong token or a stranger's session changes nothing", async () => {
    const alice = await emailed();
    const wrong = await answerIntroAction({}, form({ intro_id: alice.introId, t: "A".repeat(43), decision: "accept" }));
    expect(wrong).toEqual({ done: true, tone: "error", text: "This link is not valid or has already been used." });
    await createSession(c.ownerId);
    const stranger = await answerIntroAction({}, form({ intro_id: alice.introId, decision: "accept" }));
    expect(stranger.text).toBe("This link is not valid or has already been used.");
    expect(statusOf(alice.introId)).toBe("pending");
  });

  it("the candidate's own session needs no token", async () => {
    const alice = await emailed();
    await createSession(alice.id);
    const res = await answerIntroAction({}, form({ intro_id: alice.introId, decision: "block" }));
    expect(res).toEqual({ done: true, tone: "success", text: "Declined. Acme Labs will not contact you again." });
    expect(rows("SELECT status, candidate_blocked FROM intros WHERE id = ?", alice.introId)).toEqual([
      { status: "declined", candidate_blocked: 1 },
    ]);
    harness.jar.delete(SESSION_COOKIE);
  });

  it("after expires_at the token no longer works and the page says the request expired", async () => {
    const alice = await emailed();
    harness.raw.prepare("UPDATE intros SET expires_at = datetime('now', '-1 minute') WHERE id = ?").run(alice.introId);
    const res = await answerIntroAction({}, form({ intro_id: alice.introId, t: alice.token, decision: "accept" }));
    expect(res).toEqual({ done: true, tone: "info", text: "This request has expired." });
    expect(statusOf(alice.introId)).toBe("pending");
  });

  it("a withdrawn request says so", async () => {
    const alice = await emailed();
    await runAction("cancel_intro", { intro_id: alice.introId }, c.agent);
    const res = await answerIntroAction({}, form({ intro_id: alice.introId, t: alice.token, decision: "accept" }));
    expect(res).toEqual({ done: true, tone: "info", text: "This request was withdrawn." });
  });

  it("rejects forged input", async () => {
    const alice = await emailed();
    expect((await answerIntroAction({}, form({ intro_id: alice.introId, t: alice.token, decision: "maybe" }))).text).toBe(
      "This link is not valid or has already been used.",
    );
    expect((await answerIntroAction({}, form({ intro_id: "int_nope", t: alice.token, decision: "accept" }))).text).toBe(
      "This link is not valid or has already been used.",
    );
    expect(statusOf(alice.introId)).toBe("pending");
  });

  it("without a handle and an email the candidate is asked to add one, and can still decline", async () => {
    const ghost = addCandidate(db, { telegram: null, email: null, telegramId: null });
    const intro = (await ask(c.agent, ghost.id)).output;
    await createSession(ghost.id);
    const res = await answerIntroAction({}, form({ intro_id: intro.intro_id, decision: "accept" }));
    expect(res).toEqual({ tone: "error", text: "Add a Telegram username or an email to your account first, then accept." });
    expect((await answerIntroAction({}, form({ intro_id: intro.intro_id, decision: "decline" }))).tone).toBe("success");
  });
});
