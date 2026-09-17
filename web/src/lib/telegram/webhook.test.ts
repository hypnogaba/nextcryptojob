import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readOnlyJobsDb, type JobsDb } from "@/lib/jobs-db";
import { exec, resetHarness, rows } from "@/test/harness";
import { addPoolJob, jobsTestDb } from "@/test/jobs-db";
import { BOT_TEXT, parseCommand } from "./bot";
import { BOT_CHAT_LIMITS, handleWebhookRequest } from "./webhook";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);

// База вакансій для /jobs: прив'язку підміняємо на рівні модуля, як і в Worker лише через jobsDb().
const jobsHolder = vi.hoisted(() => ({ db: null as JobsDb | null }));
vi.mock("@/lib/jobs-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs-db")>()),
  jobsDb: () => jobsHolder.db,
}));

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

describe("reachable again", () => {
  it("a private message clears the digest's unreachable mark", async () => {
    exec(
      "INSERT INTO users (id, email, telegram_id, channel, telegram_unreachable_at) VALUES ('u_tg', NULL, '555', 'telegram', datetime('now'))",
    );
    await post(message("/help"));
    expect(rows("SELECT telegram_unreachable_at AS at FROM users WHERE id = 'u_tg'")).toEqual([{ at: null }]);
  });

  it("a group message leaves the mark", async () => {
    exec(
      "INSERT INTO users (id, email, telegram_id, channel, telegram_unreachable_at) VALUES ('u_tg', NULL, '555', 'telegram', '2026-09-16 09:05:00')",
    );
    await post(message("hi", { chatType: "supergroup" }));
    expect(rows("SELECT telegram_unreachable_at AS at FROM users WHERE id = 'u_tg'")).toEqual([{ at: "2026-09-16 09:05:00" }]);
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

  it("/start to a stranger explains how it works and what comes when", async () => {
    await post(message("/start"));
    const text = String(sent[0].body.text);
    expect(text).toContain("in your own words");
    expect(text).toContain("send you the 5 that fit you best");
    expect(text).toContain("says why it fits you");
    expect(text).toContain("/help lists the commands.");
  });

  it("/start greets a linked person with their hour, channel and /jobs", async () => {
    exec("INSERT INTO users (id, telegram_id, channel, digest_hour, timezone) VALUES ('u1', '555', 'telegram', 9, 'Europe/Paris')");
    await post(message("/start"));
    expect(sent[0].body.text).toBe(BOT_TEXT.startKnown(ORIGIN, { hour: 9, timezone: "Europe/Paris", channel: "telegram", hasEmail: false }));
    expect(plain()).toContain("Your jobs come every day at 09:00 (Europe/Paris), in this chat");
    expect(plain()).toContain("/jobs shows the jobs we already sent you.");
    expect(String(sent[0].body.text)).toContain(`<a href="${ORIGIN}/welcome?step=target">your brief</a>`);
  });

  it("/help explains how it works, lists every command and the site pages", async () => {
    await post(message("/help"));
    expect(sent[0].body.text).toBe(BOT_TEXT.help(ORIGIN, null));
    for (const c of ["/jobs", "/stop", "/start", "/help"]) expect(plain()).toContain(c);
    expect(String(sent[0].body.text)).toContain(`<a href="${ORIGIN}/settings">Settings</a>`);
    expect(plain()).toContain("This Telegram is not connected yet.");
  });

  it("/help to a linked person says when their jobs come", async () => {
    exec("INSERT INTO users (id, email, telegram_id, channel, digest_hour, timezone) VALUES ('u1', 'a@example.com', '555', 'email', 7, 'America/New_York')");
    await post(message("/help"));
    expect(plain()).toContain("Your jobs come every day at 07:00 (America/New York), by email.");
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
    expect(plain()).toBe(
      "Daily jobs are paused. We keep your brief and the jobs we sent you (/jobs).\n\nSend /start to resume, or change it in Settings.",
    );
    expect(String(sent[0].body.text)).toContain(`<a href="${ORIGIN}/settings">Settings</a>`);
    expect(rows("SELECT actor, action, meta_json FROM audit_log")).toEqual([
      { actor: "u1", action: "bot.stop", meta_json: '{"digest_paused":true}' },
    ]);
  });

  it("answers the same when already paused, without another audit entry", async () => {
    exec("INSERT INTO users (id, telegram_id, channel, digest_paused) VALUES ('u1', '555', 'telegram', 1)");
    await post(message("/stop"));
    expect(rows("SELECT digest_paused FROM users")).toEqual([{ digest_paused: 1 }]);
    expect(plain()).toContain("Daily jobs are paused.");
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
    expect(sent[0].body.text).toBe(BOT_TEXT.startResumed(ORIGIN, { hour: 7, timezone: null, channel: "telegram", hasEmail: false }));
    expect(plain()).toContain("Daily jobs are back on. They come every day at 07:00 (UTC), in this chat.");
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
    expect(plain()).toContain("Daily jobs are back on. They come every day at 07:00 (UTC), by email.");
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

describe("/jobs", () => {
  const f = new Date(Date.now() - 3_600_000).toISOString();

  beforeEach(() => {
    const jobs = jobsTestDb();
    addPoolJob(jobs.raw, { id: "mine1", title: "Solidity Engineer", company: "Aave", fetchedAt: f, url: "https://jobs.example.com/mine1?a=1&b=2" });
    addPoolJob(jobs.raw, { id: "mine2", title: "Community Manager", company: "Koinly", fetchedAt: f, url: "https://web3.career/r/wczNxUTM__U4HFyv" });
    addPoolJob(jobs.raw, { id: "theirs", title: "Secret Role", company: "Other Labs", fetchedAt: f });
    jobsHolder.db = readOnlyJobsDb(jobs.d1);
    exec("INSERT INTO users (id, telegram_id, channel, digest_hour, timezone) VALUES ('u1', '555', 'telegram', 8, 'Europe/Kyiv'), ('u2', '777', 'telegram', 8, NULL)");
    exec(`INSERT INTO digest_runs (id, user_id, local_date, status, jobs, channel) VALUES
      ('dg_1', 'u1', '2026-09-12', 'sent', 1, 'telegram'), ('dg_2', 'u1', '2026-09-13', 'sent', 1, 'telegram'),
      ('dg_3', 'u2', '2026-09-13', 'sent', 1, 'telegram'), ('dg_4', 'u1', '2026-09-14', 'failed', 1, 'telegram')`);
    exec(`INSERT INTO sent (user_id, job_ref, source, digest_id, position, status, channel, why) VALUES
      ('u1', 'nr:mine1', 'nextrole', 'dg_1', 1, 'sent', 'telegram', 'x'),
      ('u1', 'nr:mine2', 'nextrole', 'dg_2', 1, 'sent', 'telegram', 'x'),
      ('u2', 'nr:theirs', 'nextrole', 'dg_3', 1, 'sent', 'telegram', 'x'),
      ('u1', 'nr:gone', 'nextrole', 'dg_4', 1, 'failed', 'telegram', 'x')`);
  });

  it("lists only the jobs sent to this Telegram's own profile, newest first, with exact links", async () => {
    await post(message("/jobs", { fromId: 555 }));
    const text = String(sent[0].body.text);
    expect(text).toContain("The last 2 jobs we sent you");
    expect(text.indexOf("Community Manager")).toBeLessThan(text.indexOf("Solidity Engineer"));
    expect(text).toContain('<a href="https://jobs.example.com/mine1?a=1&amp;b=2">Solidity Engineer</a>');
    // web3.career: адреса як є і джерело названо.
    expect(text).toContain('<a href="https://web3.career/r/wczNxUTM__U4HFyv">Community Manager</a>');
    expect(text).toContain("via web3.career");
    expect(text).toContain("<b>Sep 13</b>");
    expect(text).toContain(`<a href="${ORIGIN}/jobs">your jobs page</a>`);
    // Чуже й не надіслане (failed) не показується.
    expect(text).not.toContain("Secret Role");
    expect(text).not.toContain("Other Labs");
    expect(text).not.toContain("no longer listed");

    await post(message("/jobs", { fromId: 777 }));
    const other = String(sent[1].body.text);
    expect(other).toContain("Secret Role");
    expect(other).not.toContain("Solidity Engineer");
    expect(other).not.toContain("Community Manager");
  });

  it("a Telegram without a profile gets a sign-in link, and nobody's jobs", async () => {
    await post(message("/jobs", { fromId: 999 }));
    expect(sent[0].body.text).toBe(BOT_TEXT.jobsNotLinked(ORIGIN));
  });

  it("nothing sent yet: says when the first jobs come", async () => {
    exec("INSERT INTO users (id, telegram_id, channel, digest_hour, timezone) VALUES ('u3', '888', 'telegram', 6, 'UTC')");
    await post(message("/jobs", { fromId: 888 }));
    expect(plain()).toContain("We have not sent you any jobs yet. Your first ones come every day at 06:00 (UTC), in this chat.");
  });
});
