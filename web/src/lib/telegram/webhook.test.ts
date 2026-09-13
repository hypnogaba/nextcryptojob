import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exec, resetHarness, rows } from "@/test/harness";
import { BOT_TEXT, parseCommand } from "./bot";
import { BOT_CHAT_LIMITS, handleWebhookRequest } from "./webhook";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);

const SECRET = "a".repeat(64);
const TOKEN = "123456:bot-token";
const ORIGIN = "https://site.test";
const env = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET };

let sent: { method: string; body: Record<string, unknown> }[] = [];
const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  sent.push({ method: String(url).split("/").pop()!, body: JSON.parse(String(init?.body)) });
  return Response.json({ ok: true, result: {} });
});

let nextUpdateId = 1000;
function request(body: unknown, secret: string | null = SECRET): Request {
  const headers = new Headers({ "content-type": "application/json", "cf-connecting-ip": "149.154.167.1" });
  if (secret !== null) headers.set("x-telegram-bot-api-secret-token", secret);
  return new Request(`${ORIGIN}/api/telegram/webhook`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function message(text: string, over: { chatType?: string; fromId?: number; updateId?: number } = {}) {
  const fromId = over.fromId ?? 555;
  return {
    update_id: over.updateId ?? nextUpdateId++,
    message: {
      message_id: 1,
      chat: { id: over.chatType && over.chatType !== "private" ? -100 : fromId, type: over.chatType ?? "private" },
      from: { id: fromId, is_bot: false, first_name: "Ada" },
      text,
    },
  };
}

const post = (body: unknown, secret: string | null = SECRET, e: typeof env | Record<string, string> = env) =>
  handleWebhookRequest(request(body, secret), e, { fetchImpl, sleep: async () => {} });

beforeEach(() => {
  resetHarness();
  sent = [];
  fetchImpl.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("webhook secret", () => {
  it("fails closed when TELEGRAM_WEBHOOK_SECRET is not set", async () => {
    const res = await post(message("/start"), SECRET, { TELEGRAM_BOT_TOKEN: TOKEN });
    expect(res.status).toBe(401);
    expect(sent).toEqual([]);
    expect(rows("SELECT * FROM webhook_updates")).toEqual([]);
  });

  it.each([
    ["missing", null],
    ["empty", ""],
    ["wrong", "b".repeat(64)],
    ["a prefix of the secret", SECRET.slice(0, 32)],
  ])("rejects a %s header with 401 and touches nothing", async (_name, secret) => {
    const res = await post(message("/start"), secret);
    expect(res.status).toBe(401);
    expect(sent).toEqual([]);
    expect(rows("SELECT * FROM webhook_updates")).toEqual([]);
  });

  it("answers 200 to junk once the secret is right", async () => {
    expect((await post("not json")).status).toBe(200);
    expect((await post({ no: "update_id" })).status).toBe(200);
    expect(sent).toEqual([]);
  });
});

describe("dedupe", () => {
  it("handles each update_id once", async () => {
    const update = message("/start", { updateId: 7 });
    expect((await post(update)).status).toBe(200);
    expect((await post(update)).status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(rows("SELECT update_id FROM webhook_updates")).toEqual([{ update_id: 7 }]);
  });
});

describe("commands", () => {
  it("parses commands with a bot name and payload", () => {
    expect(parseCommand("/start")).toBe("start");
    expect(parseCommand("/Start@nextcryptojob_bot abc")).toBe("start");
    expect(parseCommand("hello /start")).toBeNull();
    expect(parseCommand(undefined)).toBeNull();
  });

  it("/start welcomes a stranger with a link to the site", async () => {
    await post(message("/start"));
    expect(sent).toEqual([
      {
        method: "sendMessage",
        body: {
          chat_id: 555,
          text: BOT_TEXT.startNew(ORIGIN),
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        },
      },
    ]);
    expect(String(sent[0].body.text)).toContain(`<a href="${ORIGIN}/login">site.test/login</a>`);
  });

  it("/start greets a linked person differently", async () => {
    exec("INSERT INTO users (id, telegram_id) VALUES ('u1', '555')");
    await post(message("/start"));
    expect(sent[0].body.text).toBe(BOT_TEXT.startKnown(ORIGIN));
  });

  it("/help lists the commands", async () => {
    await post(message("/help"));
    expect(sent[0].body.text).toBe(BOT_TEXT.help(ORIGIN));
  });

  it("answers other text with the list of commands", async () => {
    await post(message("hello"));
    expect(sent[0].body.text).toBe(BOT_TEXT.unknown());
  });

  it("stays silent in groups", async () => {
    await post(message("/start", { chatType: "supergroup" }));
    expect(sent).toEqual([]);
  });
});

/** Видимий текст повідомлення бота, без розмітки HTML. */
const plain = (i = 0) => String(sent[i].body.text).replace(/<[^>]+>/g, "");

describe("/stop", () => {
  it.each([
    ["Telegram, no email", "INSERT INTO users (id, telegram_id, channel) VALUES ('u1', '555', 'telegram')"],
    [
      "Telegram, with email",
      "INSERT INTO users (id, email, telegram_id, channel) VALUES ('u1', 'ada@example.com', '555', 'telegram')",
    ],
    [
      "email",
      "INSERT INTO users (id, email, telegram_id, channel) VALUES ('u1', 'ada@example.com', '555', 'email')",
    ],
  ])("pauses daily jobs whatever the channel (%s) and keeps the channel", async (_name, insert) => {
    exec(insert);
    const [{ channel }] = rows<{ channel: string }>("SELECT channel FROM users");
    await post(message("/stop"));
    expect(rows("SELECT digest_paused, channel FROM users")).toEqual([{ digest_paused: 1, channel }]);
    expect(plain()).toBe("Daily jobs are paused. Send /start to resume, or change it in Settings.");
    expect(String(sent[0].body.text)).toContain(`<a href="${ORIGIN}/settings">Settings</a>`);
    expect(rows("SELECT actor, action, meta_json FROM audit_log")).toEqual([
      { actor: "u1", action: "bot.stop", meta_json: '{"digest_paused":true}' },
    ]);
  });

  it("answers the same when already paused, without another audit entry", async () => {
    exec("INSERT INTO users (id, telegram_id, channel, digest_paused) VALUES ('u1', '555', 'telegram', 1)");
    await post(message("/stop"));
    expect(rows("SELECT digest_paused FROM users")).toEqual([{ digest_paused: 1 }]);
    expect(plain()).toBe("Daily jobs are paused. Send /start to resume, or change it in Settings.");
    expect(rows("SELECT action FROM audit_log")).toEqual([]);
  });

  it("says there is nothing to stop for a stranger", async () => {
    exec("INSERT INTO users (id, telegram_id) VALUES ('u1', '777')");
    await post(message("/stop"));
    expect(sent[0].body.text).toBe(BOT_TEXT.stopNotLinked());
    expect(rows("SELECT digest_paused FROM users")).toEqual([{ digest_paused: 0 }]);
  });
});

describe("/start after /stop", () => {
  it("clears the pause and says where daily jobs go", async () => {
    exec("INSERT INTO users (id, telegram_id, channel, digest_paused) VALUES ('u1', '555', 'telegram', 1)");
    await post(message("/start"));
    expect(rows("SELECT digest_paused FROM users")).toEqual([{ digest_paused: 0 }]);
    expect(sent[0].body.text).toBe(BOT_TEXT.startResumed(ORIGIN, "telegram"));
    expect(plain()).toContain("Daily jobs are back on. They come to this chat.");
    expect(rows("SELECT actor, action, meta_json FROM audit_log")).toEqual([
      { actor: "u1", action: "bot.start", meta_json: '{"digest_paused":false}' },
    ]);
  });

  it("names email when that is the channel", async () => {
    exec(
      "INSERT INTO users (id, email, telegram_id, channel, digest_paused) VALUES ('u1', 'a@example.com', '555', 'email', 1)",
    );
    await post(message("/start"));
    expect(rows("SELECT digest_paused FROM users")).toEqual([{ digest_paused: 0 }]);
    expect(plain()).toContain("Daily jobs are back on. They go to your email.");
  });

  it("a stop then a start leaves daily jobs on", async () => {
    exec("INSERT INTO users (id, telegram_id, channel) VALUES ('u1', '555', 'telegram')");
    await post(message("/stop"));
    await post(message("/start"));
    expect(rows("SELECT digest_paused FROM users")).toEqual([{ digest_paused: 0 }]);
    expect(rows("SELECT action FROM audit_log ORDER BY id")).toEqual([{ action: "bot.stop" }, { action: "bot.start" }]);
  });
});

describe("errors", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("answers 500 when the update cannot be claimed, so Telegram sends it again", async () => {
    exec("DROP TABLE webhook_updates");
    const res = await post(message("/start", { updateId: 42 }));
    expect(res.status).toBe(500);
    expect(sent).toEqual([]);
  });

  it("handles the retried update once the database is back", async () => {
    const update = message("/start", { updateId: 43 });
    exec("ALTER TABLE webhook_updates RENAME TO webhook_updates_off");
    expect((await post(update)).status).toBe(500);
    exec("ALTER TABLE webhook_updates_off RENAME TO webhook_updates");
    expect((await post(update)).status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("answers 200 when handling fails after the claim, so the update is not replayed", async () => {
    exec("DROP TABLE auth_attempts");
    const update = message("/start", { updateId: 44 });
    expect((await post(update)).status).toBe(200);
    expect(rows("SELECT update_id FROM webhook_updates")).toEqual([{ update_id: 44 }]);
    expect(sent).toEqual([]);
  });
});

describe("callback queries", () => {
  it("answers unknown buttons with 'Unknown action'", async () => {
    await post({
      update_id: nextUpdateId++,
      callback_query: {
        id: "cb1",
        from: { id: 555 },
        data: "intro:accept:42",
        message: { message_id: 3, chat: { id: 555, type: "private" } },
      },
    });
    expect(sent).toEqual([
      { method: "answerCallbackQuery", body: { callback_query_id: "cb1", text: "Unknown action" } },
    ]);
  });
});

describe("intro buttons (CRM 5.5)", () => {
  const INTRO = "int_ABCDEFGHIJKLMNOPQRST";
  const CANDIDATE = "aaaaaaaa-1111-4111-8111-111111111111";

  /** Кандидат з Telegram 555 і запит знайомства від Acme Labs, що чекає відповіді. */
  function seedIntro() {
    exec(
      `INSERT INTO users (id, email, telegram_id, telegram_username, channel, roles, visible_to_companies)
       VALUES (?, 'alice@example.com', '555', 'alice_eth', 'telegram', '["engineer"]', 1)`,
      CANDIDATE,
    );
    exec(
      `INSERT INTO companies (id, name, terms_version, terms_accepted_at)
       VALUES ('co_AAAAAAAAAAAAAAAAAAAA', 'Acme Labs', 'v1', datetime('now'))`,
    );
    exec(
      `INSERT INTO pipeline (company_id, user_id, stage, added_via)
       VALUES ('co_AAAAAAAAAAAAAAAAAAAA', ?, 'intro_requested', 'rest')`,
      CANDIDATE,
    );
    exec(
      `INSERT INTO intros (id, company_id, user_id, mode, status, message, requested_via, respond_token_hash, expires_at)
       VALUES (?, 'co_AAAAAAAAAAAAAAAAAAAA', ?, 'approval', 'pending', 'We would like to talk about a Solidity role.',
               'rest', 'h', datetime('now', '+14 days'))`,
      INTRO,
      CANDIDATE,
    );
  }

  const press = (data: string, fromId = 555) => ({
    update_id: nextUpdateId++,
    callback_query: {
      id: "cb-intro",
      from: { id: fromId },
      data,
      message: { message_id: 7, chat: { id: fromId, type: "private" } },
    },
  });

  it("Accept from the candidate's Telegram reaches the intro flow, answers the button and writes the result in the chat", async () => {
    seedIntro();
    vi.spyOn(console, "info").mockImplementation(() => {});
    expect((await post(press(`ia:${INTRO}`))).status).toBe(200);

    expect(rows("SELECT status, contact_value FROM intros WHERE id = ?", INTRO)).toEqual([
      { status: "accepted", contact_value: "@alice_eth" },
    ]);
    expect(rows("SELECT stage FROM pipeline WHERE user_id = ?", CANDIDATE)).toEqual([{ stage: "contact_shared" }]);
    const done = "Done. Acme Labs can now see your Telegram handle.";
    expect(sent.find((s) => s.method === "answerCallbackQuery")?.body).toEqual({ callback_query_id: "cb-intro", text: done });
    expect(sent.find((s) => s.method === "sendMessage" && s.body.chat_id === 555)?.body).toMatchObject({ text: done });
    expect(sent.find((s) => s.method === "editMessageReplyMarkup")?.body).toEqual({
      chat_id: 555,
      message_id: 7,
      reply_markup: { inline_keyboard: [] },
    });
  });

  it("a failure inside the intro flow still answers the button", async () => {
    seedIntro();
    vi.spyOn(console, "error").mockImplementation(() => {});
    exec("ALTER TABLE intros RENAME TO intros_broken");
    expect((await post(press(`ia:${INTRO}`))).status).toBe(200);
    expect(sent).toEqual([
      {
        method: "answerCallbackQuery",
        body: { callback_query_id: "cb-intro", text: "Something went wrong. Try again from the link in the message." },
      },
    ]);
  });

  it("a press from another Telegram account changes nothing and only answers the button", async () => {
    seedIntro();
    await post(press(`id:${INTRO}`, 556));
    expect(rows("SELECT status FROM intros WHERE id = ?", INTRO)).toEqual([{ status: "pending" }]);
    expect(sent).toEqual([
      { method: "answerCallbackQuery", body: { callback_query_id: "cb-intro", text: "This request is for another account." } },
    ]);
  });
});

describe("per-chat limit", () => {
  it("stops answering a chat that floods the bot", async () => {
    for (let i = 0; i < BOT_CHAT_LIMITS.maxAttempts + 3; i++) await post(message("/help"));
    expect(sent).toHaveLength(BOT_CHAT_LIMITS.maxAttempts);
  });
});
