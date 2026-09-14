import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSettingsCache } from "@/lib/admin/settings";
import { SIGNUPS_CLOSED } from "@/lib/auth/code-messages";
import { RedirectCalled, exec, harness, resetHarness, rows } from "@/test/harness";
import { loginAction, type LoginState } from "./actions";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/navigation", async () => (await import("@/test/harness")).navigationModule);

let outbox: { subject: string }[] = [];
const EMAIL_STEP: LoginState = { step: "email", email: "" };

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

/** Запитати код через дію й повернути його з листа. */
async function codeFor(email: string): Promise<string> {
  const state = await loginAction(EMAIL_STEP, form({ intent: "send", email }));
  expect(state.step).toBe("code");
  return outbox.at(-1)!.subject.match(/(\d{6})$/)![1];
}

async function signIn(email: string): Promise<string> {
  const code = await codeFor(email);
  const err = await loginAction({ step: "code", email }, form({ intent: "verify", email, code })).catch((e) => e);
  expect(err).toBeInstanceOf(RedirectCalled);
  return (err as RedirectCalled).url;
}

beforeEach(() => {
  outbox = [];
  resetSettingsCache();
  resetHarness({
    EMAIL: { send: async (m: { subject: string }) => (outbox.push(m), { messageId: "m" }) } as unknown as SendEmail,
  });
  harness.headers = new Headers({ "cf-connecting-ip": "203.0.113.7" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("loginAction", () => {
  it("sends a new person to /welcome", async () => {
    await expect(signIn("new@example.com")).resolves.toBe("/welcome");
  });

  it("sends a returning person to /account", async () => {
    exec("INSERT INTO users (id, email) VALUES ('u1', 'back@example.com')");
    await expect(signIn("back@example.com")).resolves.toBe("/account");
  });

  it("sends an admin straight to /admin, new or returning, and never through the brief", async () => {
    (harness.env as { ADMIN_EMAILS?: string }).ADMIN_EMAILS = "boss@example.com, Other@Example.com";
    await expect(signIn("boss@example.com")).resolves.toBe("/admin");
    await expect(signIn("boss@example.com")).resolves.toBe("/admin");
    await expect(signIn("OTHER@example.com")).resolves.toBe("/admin");
    await expect(signIn("new@example.com")).resolves.toBe("/welcome");
    expect(rows("SELECT method FROM sessions ORDER BY rowid")).toEqual([
      { method: "email" }, { method: "email" }, { method: "email" }, { method: "email" },
    ]);
  });

  it("tells the person email sign-in opens soon when there is no mail service", async () => {
    vi.stubEnv("NODE_ENV", "production");
    harness.env.EMAIL = undefined;
    await expect(loginAction(EMAIL_STEP, form({ intent: "send", email: "ada@example.com" }))).resolves.toEqual({
      step: "email",
      email: "ada@example.com",
      message: { tone: "info", text: "Email sign-in opens soon." },
    });
  });

  it("with sign-ups closed, a new email gets a closed-for-now message and no account; an existing one signs in", async () => {
    exec("INSERT INTO app_settings (key, value_json) VALUES ('signups_open', 'false')");
    exec("INSERT INTO users (id, email) VALUES ('u1', 'back@example.com')");

    const code = await codeFor("new@example.com");
    const state = await loginAction({ step: "code", email: "new@example.com" }, form({ intent: "verify", email: "new@example.com", code }));
    expect(state).toEqual({ step: "email", email: "new@example.com", message: { tone: "info", text: SIGNUPS_CLOSED } });
    expect(rows("SELECT id FROM users WHERE email = 'new@example.com'")).toEqual([]);
    expect(rows("SELECT id FROM sessions")).toEqual([]);
    expect(rows("SELECT actor, action, meta_json FROM audit_log")).toEqual([
      { actor: null, action: "auth.signup_closed", meta_json: '{"method":"email"}' },
    ]);

    await expect(signIn("back@example.com")).resolves.toBe("/account");
    expect(rows("SELECT user_id, method FROM sessions")).toEqual([{ user_id: "u1", method: "email" }]);
  });

  it("shows how many tries are left after a wrong code", async () => {
    const code = await codeFor("ada@example.com");
    const bad = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    const state = await loginAction(
      { step: "code", email: "ada@example.com" },
      form({ intent: "verify", email: "ada@example.com", code: bad }),
    );
    expect(state).toEqual({
      step: "code",
      email: "ada@example.com",
      message: { tone: "error", text: "That code is not right. 4 tries left." },
    });
  });
});
