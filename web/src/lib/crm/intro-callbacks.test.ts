import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TgCallbackQuery } from "@/lib/telegram/bot";
import { all, crmDb, publishFormula, run } from "@/test/crm-fixtures";
import { addCandidate, addTestCompany, ask, BOT_TOKEN, stubNetwork, type Network, type TestCompany } from "@/test/intro-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { runAction } from "./actions";
import { handleIntroCallback, type IntroCallbackEnv } from "./intro-callbacks";
import { candidateLabel } from "./project";

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

const LATER = new Date("2026-09-13T09:00:00Z");
const env = (now = LATER): IntroCallbackEnv => ({ token: BOT_TOKEN, origin: "https://nextcryptojob.xyz", db: db.d1, mailer: null, now });

function press(data: string, fromId: string | number, messageId = 42): TgCallbackQuery {
  return {
    id: `cb${Math.random()}`,
    from: { id: Number(fromId) },
    data,
    message: { message_id: messageId, chat: { id: Number(fromId), type: "private" } },
  };
}

async function requested() {
  const alice = addCandidate(db);
  const intro = (await ask(c.agent, alice.id)).output;
  return { ...alice, introId: intro.intro_id };
}

const status = (id: string) => all<{ status: string; candidate_blocked: number }>(db.raw, "SELECT status, candidate_blocked FROM intros WHERE id = ?", id)[0];
const edits = () => net.tg.filter((m) => m.method === "editMessageReplyMarkup");

describe("intro buttons in Telegram", () => {
  it("Accept from the candidate's own Telegram shares the handle, clears the buttons and tells the company", async () => {
    const alice = await requested();
    const before = net.tg.length;
    const r = await handleIntroCallback(press(`ia:${alice.introId}`, alice.telegramId!), env());
    expect(r).toEqual({ answer: "Done. Acme Labs can now see your Telegram handle.", reply: "Done. Acme Labs can now see your Telegram handle." });
    expect(status(alice.introId).status).toBe("accepted");
    expect(all(db.raw, "SELECT stage FROM pipeline WHERE company_id = ?", c.co)).toEqual([{ stage: "contact_shared" }]);
    expect(edits()).toEqual([
      {
        method: "editMessageReplyMarkup",
        payload: { chat_id: Number(alice.telegramId), message_id: 42, reply_markup: { inline_keyboard: [] } },
      },
    ]);
    const toCompany = net.tg.slice(before).filter((m) => m.method === "sendMessage");
    expect(toCompany.map((m) => String(m.payload.chat_id))).toEqual([c.ownerTelegram]);
    expect(String(toCompany[0].payload.text)).toContain(`Candidate ${candidateLabel(alice.id)} accepted your intro request.`);
    expect(String(toCompany[0].payload.text)).not.toContain("alice_eth");
    // Картка компанії показує нік.
    const card = (await runAction("list_pipeline", {}, c.agent)).output as { data: { contact: { value: string } | null }[] };
    expect(card.data[0].contact?.value).toBe("@alice_eth");
  });

  it("a second Accept answers 'already answered' and changes nothing", async () => {
    const alice = await requested();
    await handleIntroCallback(press(`ia:${alice.introId}`, alice.telegramId!), env());
    const events = all(db.raw, "SELECT * FROM pipeline_events");
    const r = await handleIntroCallback(press(`ia:${alice.introId}`, alice.telegramId!), env());
    expect(r.answer).toBe("You already answered this request.");
    expect(all(db.raw, "SELECT * FROM pipeline_events")).toEqual(events);
  });

  it("Decline and Decline and block", async () => {
    const alice = await requested();
    expect((await handleIntroCallback(press(`id:${alice.introId}`, alice.telegramId!), env())).answer).toBe(
      "Declined. Acme Labs will not contact you.",
    );
    expect(status(alice.introId)).toEqual({ status: "declined", candidate_blocked: 0 });

    const bob = await requested();
    expect((await handleIntroCallback(press(`ib:${bob.introId}`, bob.telegramId!), env())).answer).toBe(
      "Declined. Acme Labs will not contact you again.",
    );
    expect(status(bob.introId)).toEqual({ status: "declined", candidate_blocked: 1 });
    expect(
      all(db.raw, "SELECT e.kind FROM pipeline_events e JOIN pipeline p ON p.id = e.pipeline_id WHERE p.user_id = ? ORDER BY e.id", bob.id),
    ).toEqual([{ kind: "added" }, { kind: "intro_requested" }, { kind: "intro_declined" }, { kind: "visibility_lost" }]);
  });

  it("another Telegram account cannot answer, and the buttons stay", async () => {
    const alice = await requested();
    const r = await handleIntroCallback(press(`ia:${alice.introId}`, c.ownerTelegram), env());
    expect(r).toEqual({ answer: "This request is for another account.", reply: null });
    expect(status(alice.introId).status).toBe("pending");
    expect(edits()).toEqual([]);
  });

  it("expired and withdrawn requests say so and lose their buttons", async () => {
    const alice = await requested();
    const late = await handleIntroCallback(press(`ia:${alice.introId}`, alice.telegramId!), env(new Date("2026-10-01T00:00:00Z")));
    expect(late.answer).toBe("This request has expired.");
    expect(status(alice.introId).status).toBe("pending");

    await runAction("cancel_intro", { intro_id: alice.introId }, c.agent);
    const gone = await handleIntroCallback(press(`ia:${alice.introId}`, alice.telegramId!), env());
    expect(gone.answer).toBe("This request was withdrawn.");
    expect(edits()).toHaveLength(2);
  });

  it("ignores data it does not own and unknown ids", async () => {
    expect(await handleIntroCallback(press("zz:whatever", 1), env())).toEqual({ answer: "Unknown action", reply: null });
    expect(await handleIntroCallback(press("ia:int_short", 1), env())).toEqual({ answer: "Unknown action", reply: null });
    expect(await handleIntroCallback(press("ia:int_00000000000000000000", 1), env())).toEqual({
      answer: "This link is not valid or has already been used.",
      reply: null,
    });
  });

  it("escapes the company name in the chat reply", async () => {
    run(db.raw, "UPDATE companies SET name = '<b>Acme</b> & Co' WHERE id = ?", c.co);
    const alice = await requested();
    const r = await handleIntroCallback(press(`id:${alice.introId}`, alice.telegramId!), env());
    expect(r.answer).toBe("Declined. <b>Acme</b> & Co will not contact you.");
    expect(r.reply).toBe("Declined. &lt;b&gt;Acme&lt;/b&gt; &amp; Co will not contact you.");
  });
});
