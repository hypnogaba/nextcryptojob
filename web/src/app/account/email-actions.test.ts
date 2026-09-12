import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentAdmin } from "@/lib/auth/admin";
import { requestCode, verifyCode } from "@/lib/auth/email-code";
import { createSession, SESSION_COOKIE } from "@/lib/auth/session";
import { setChannel } from "@/lib/telegram/channel";
import { RedirectCalled, exec, harness, resetHarness, rows } from "@/test/harness";
import { saveDailyJobsAction } from "../settings/actions";
import { addEmailAction, type AddEmailState } from "./email-actions";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/navigation", async () => (await import("@/test/harness")).navigationModule);
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

type Sent = { to: string; subject: string; text: string };
let outbox: Sent[] = [];

const EMAIL_STEP: AddEmailState = { step: "email", email: "" };
const TAKEN = "This email is linked to another profile.";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

async function run<T>(p: Promise<T>): Promise<T | string> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof RedirectCalled) return err.url;
    throw err;
  }
}

const lastCode = () => outbox.at(-1)!.subject.match(/(\d{6})$/)![1];

const send = (email: string) => addEmailAction(EMAIL_STEP, form({ intent: "send", email }));
const verify = (email: string, code: string) =>
  addEmailAction({ step: "code", email }, form({ intent: "verify", email, code }));

/** Людина лише з Telegram, у сесії, відкритій через Telegram. */
async function signInTelegramOnly(id = "tg", telegramId = "555") {
  exec("INSERT INTO users (id, telegram_id, channel) VALUES (?, ?, 'telegram')", id, telegramId);
  await createSession(id, "telegram");
}

beforeEach(() => {
  outbox = [];
  resetHarness({
    EMAIL: { send: async (m: Sent) => (outbox.push(m), { messageId: "m" }) } as unknown as SendEmail,
  });
  harness.headers = new Headers({ "cf-connecting-ip": "203.0.113.7" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("addEmailAction", () => {
  it("adds the email only after the code from that email is checked", async () => {
    await signInTelegramOnly();

    const sent = await send(" Ada@Example.com ");
    expect(sent).toMatchObject({ step: "code", email: "ada@example.com" });
    expect(outbox).toHaveLength(1);
    expect(outbox[0].to).toBe("ada@example.com");
    expect(outbox[0].text).toContain("add this email to your NextCryptoJob profile");
    // Код надіслано, але пошти в профілі ще немає.
    expect(rows("SELECT email FROM users")).toEqual([{ email: null }]);

    const wrong = String((Number(lastCode()) + 1) % 1_000_000).padStart(6, "0");
    await expect(verify("ada@example.com", wrong)).resolves.toMatchObject({
      step: "code",
      message: { tone: "error", text: "That code is not right. 4 tries left." },
    });
    expect(rows("SELECT email FROM users")).toEqual([{ email: null }]);

    await expect(verify("ada@example.com", lastCode())).resolves.toMatchObject({
      step: "done",
      email: "ada@example.com",
      message: { tone: "success" },
    });
    expect(rows("SELECT id, email, telegram_id, channel FROM users")).toEqual([
      { id: "tg", email: "ada@example.com", telegram_id: "555", channel: "telegram" },
    ]);
    expect(rows("SELECT actor, action, target, meta_json FROM audit_log")).toEqual([
      { actor: "tg", action: "account.email_added", target: "tg", meta_json: null },
    ]);
  });

  it("lets daily jobs switch to email once the email is added", async () => {
    await signInTelegramOnly();
    await expect(setChannel(harness.env.DB, "tg", "email")).resolves.toBe("no_email");
    await send("ada@example.com");
    await verify("ada@example.com", lastCode());
    const saved = await saveDailyJobsAction({}, form({ channel: "email", hour: "9", timezone: "UTC" }));
    expect(saved).toMatchObject({ message: { tone: "success" } });
    expect(rows("SELECT channel FROM users")).toEqual([{ channel: "email" }]);
  });

  it("refuses an email that belongs to another profile and changes nothing", async () => {
    exec("INSERT INTO users (id, email) VALUES ('other', 'Ada@Example.com')");
    await signInTelegramOnly();
    await send("ada@example.com");
    await expect(verify("ada@example.com", lastCode())).resolves.toMatchObject({
      step: "email",
      message: { tone: "error", text: TAKEN },
    });
    expect(rows("SELECT id, email FROM users ORDER BY id")).toEqual([
      { id: "other", email: "Ada@Example.com" },
      { id: "tg", email: null },
    ]);
    expect(rows("SELECT action FROM audit_log")).toEqual([{ action: "account.email_conflict" }]);
  });

  it("keeps the person in the same session, opened by Telegram", async () => {
    await signInTelegramOnly();
    const before = harness.jar.get(SESSION_COOKIE)?.value;
    await send("ada@example.com");
    await verify("ada@example.com", lastCode());
    expect(harness.jar.get(SESSION_COOKIE)?.value).toBe(before);
    expect(rows("SELECT method FROM sessions")).toEqual([{ method: "telegram" }]);
  });

  it("does not make a Telegram session an admin one by adding the admin's email", async () => {
    harness.env = { ...harness.env, ADMIN_EMAILS: "boss@example.com" } as never;
    await signInTelegramOnly();
    await send("boss@example.com");
    await verify("boss@example.com", lastCode());
    expect(rows("SELECT email FROM users")).toEqual([{ email: "boss@example.com" }]);
    await expect(currentAdmin()).resolves.toBeNull();
  });

  it("binds the code to the person who asked for it", async () => {
    await signInTelegramOnly("tg", "555");
    await send("ada@example.com");
    const code = lastCode();

    // Інша людина з тим самим кодом цю пошту собі не додасть.
    harness.jar.delete(SESSION_COOKIE);
    await signInTelegramOnly("tg2", "777");
    await expect(verify("ada@example.com", code)).resolves.toMatchObject({ step: "code", message: { tone: "error" } });

    // І ввійти цим кодом як у звичайний вхід не вийде.
    await expect(verifyCode("ada@example.com", code)).resolves.toMatchObject({ ok: false, reason: "wrong_code" });
    expect(rows("SELECT email FROM users WHERE email IS NOT NULL")).toEqual([]);
  });

  it("does not accept a sign-in code for adding an email", async () => {
    await signInTelegramOnly();
    await requestCode("ada@example.com", "203.0.113.7");
    await expect(verify("ada@example.com", lastCode())).resolves.toMatchObject({ step: "code", message: { tone: "error" } });
    expect(rows("SELECT email FROM users")).toEqual([{ email: null }]);
  });

  it("shares the sign-in limits: five codes per address per hour", async () => {
    await signInTelegramOnly();
    for (let i = 0; i < 3; i++) await requestCode("ada@example.com", "198.51.100.1");
    for (let i = 0; i < 2; i++) await expect(send("ada@example.com")).resolves.toMatchObject({ step: "code" });
    await expect(send("ada@example.com")).resolves.toMatchObject({
      message: { tone: "error", text: expect.stringContaining("Too many codes requested") },
    });
    expect(outbox).toHaveLength(5);
  });

  it("refuses a profile that already has an email, without sending anything", async () => {
    exec("INSERT INTO users (id, email) VALUES ('u', 'u@example.com')");
    await createSession("u", "email");
    await expect(send("new@example.com")).resolves.toMatchObject({
      message: { tone: "error", text: "Your profile already has an email." },
    });
    expect(outbox).toEqual([]);
    expect(rows("SELECT email FROM users")).toEqual([{ email: "u@example.com" }]);
  });

  it("sends a signed-out visitor to /login", async () => {
    await expect(run(send("ada@example.com"))).resolves.toBe("/login");
    expect(outbox).toEqual([]);
  });

  it("lets the person go back and use a different email", async () => {
    await signInTelegramOnly();
    await expect(
      addEmailAction({ step: "code", email: "ada@example.com" }, form({ intent: "change", email: "ada@example.com" })),
    ).resolves.toEqual({ step: "email", email: "ada@example.com" });
  });
});
