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

describe("/stop", () => {
  it("moves daily jobs back to email when the person has one", async () => {
    exec("INSERT INTO users (id, email, telegram_id, channel) VALUES ('u1', 'ada@example.com', '555', 'telegram')");
    await post(message("/stop"));
    expect(rows("SELECT channel FROM users")).toEqual([{ channel: "email" }]);
    expect(sent[0].body.text).toBe(BOT_TEXT.stopDone(ORIGIN));
    expect(rows("SELECT action, meta_json FROM audit_log")).toEqual([
      { action: "bot.stop", meta_json: '{"channel":"email"}' },
    ]);
  });

  it("explains how to change it on the site when there is no email", async () => {
    exec("INSERT INTO users (id, telegram_id, channel) VALUES ('u1', '555', 'telegram')");
    await post(message("/stop"));
    expect(rows("SELECT channel FROM users")).toEqual([{ channel: "telegram" }]);
    expect(sent[0].body.text).toBe(BOT_TEXT.stopNoEmail(ORIGIN));
  });

  it("says so when daily jobs already go to email", async () => {
    exec("INSERT INTO users (id, email, telegram_id, channel) VALUES ('u1', 'a@example.com', '555', 'email')");
    await post(message("/stop"));
    expect(sent[0].body.text).toBe(BOT_TEXT.stopAlreadyEmail());
  });

  it("says there is nothing to stop for a stranger", async () => {
    await post(message("/stop"));
    expect(sent[0].body.text).toBe(BOT_TEXT.stopNotLinked());
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

describe("per-chat limit", () => {
  it("stops answering a chat that floods the bot", async () => {
    for (let i = 0; i < BOT_CHAT_LIMITS.maxAttempts + 3; i++) await post(message("/help"));
    expect(sent).toHaveLength(BOT_CHAT_LIMITS.maxAttempts);
  });
});
