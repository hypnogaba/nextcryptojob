import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exec, harness, resetHarness, rows } from "@/test/harness";
import { CLIENT_ID, CLIENT_SECRET, NOW, rsaSigner, telegramClaims, type TestSigner } from "@/test/jwt";
import { SESSION_COOKIE, createSession } from "./session";
import { beginTelegramLogin, finishTelegramLogin, TELEGRAM_CALLBACK_IP_LIMITS } from "./telegram-login";
import { decodeFlow, FLOW_COOKIE, TOKEN_ENDPOINT, type OidcFlow } from "./telegram-oidc";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/navigation", async () => (await import("@/test/harness")).navigationModule);

const ORIGIN = "https://site.test";
let signer: TestSigner;
let claimsOver: Record<string, unknown> = {};
let tokenCalls: RequestInit[] = [];

/** Підставний /token: віддає ID-токен, підписаний тестовим ключем, з nonce цього входу. */
function fetchImpl(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  expect(String(url)).toBe(TOKEN_ENDPOINT);
  tokenCalls.push(init ?? {});
  const nonce = currentFlow()?.nonce ?? "none";
  return signer.sign(telegramClaims(nonce, claimsOver)).then((id_token) => Response.json({ id_token }));
}
const deps = () => ({ fetchImpl, nowSeconds: NOW, keyFor: async () => signer.publicKey });

let lastFlow: OidcFlow | null = null;
const currentFlow = () => lastFlow;

/** Натиснути кнопку: кука стану в банці, адреса Telegram у відповіді. */
async function begin(): Promise<URL> {
  const url = await beginTelegramLogin(ORIGIN, deps());
  expect(url).not.toBeNull();
  lastFlow = decodeFlow(harness.jar.get(FLOW_COOKIE)?.value, NOW);
  return new URL(url!);
}

/** Повернення від Telegram з тим самим state (або підробленим). */
function finish(params: Record<string, string>) {
  return finishTelegramLogin(new URLSearchParams(params), ORIGIN, deps());
}

async function roundTrip(): Promise<string> {
  const url = await begin();
  return finish({ code: "auth-code", state: url.searchParams.get("state")! });
}

beforeEach(async () => {
  signer ??= await rsaSigner();
  claimsOver = {};
  tokenCalls = [];
  lastFlow = null;
  resetHarness({ TELEGRAM_OIDC_CLIENT_ID: CLIENT_ID, TELEGRAM_OIDC_CLIENT_SECRET: CLIENT_SECRET } as never);
  harness.headers = new Headers({ "cf-connecting-ip": "203.0.113.9" });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("beginTelegramLogin", () => {
  it("does nothing without OIDC keys", async () => {
    resetHarness();
    await expect(beginTelegramLogin(ORIGIN)).resolves.toBeNull();
    expect(harness.jar.store.size).toBe(0);
  });

  it("stores state, verifier and nonce in a 10-minute __Host- HttpOnly cookie", async () => {
    const url = await begin();
    const cookie = harness.jar.store.get(FLOW_COOKIE)!;
    expect(cookie.options).toEqual({ httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 600 });
    expect(url.searchParams.get("state")).toBe(lastFlow!.state);
    expect(url.searchParams.get("nonce")).toBe(lastFlow!.nonce);
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/telegram/callback`);
    expect(lastFlow!.linkUserId).toBeNull();
  });

  it("remembers who is connecting Telegram from the account page", async () => {
    exec("INSERT INTO users (id, email) VALUES ('u1', 'ada@example.com')");
    await createSession("u1", null);
    await begin();
    expect(lastFlow!.linkUserId).toBe("u1");
  });

  it.each(["cross-site", "same-site"])("refuses to start connecting Telegram when %s sent the signed-in person here", async (site) => {
    exec("INSERT INTO users (id, email) VALUES ('u1', 'ada@example.com')");
    await createSession("u1", null);
    harness.headers.set("sec-fetch-site", site);
    await expect(beginTelegramLogin(ORIGIN, deps())).resolves.toBe(`${ORIGIN}/auth/telegram/error?reason=cross_site`);
    expect(harness.jar.get(FLOW_COOKIE)).toBeUndefined();
  });

  it.each(["same-origin", "none", null])("lets a signed-in person connect Telegram from %s", async (site) => {
    exec("INSERT INTO users (id, email) VALUES ('u1', 'ada@example.com')");
    await createSession("u1", null);
    if (site) harness.headers.set("sec-fetch-site", site);
    const url = await begin();
    expect(url.origin).toBe("https://oauth.telegram.org");
    expect(lastFlow!.linkUserId).toBe("u1");
  });

  it("still lets a signed-out visitor from another site sign in with Telegram", async () => {
    harness.headers.set("sec-fetch-site", "cross-site");
    const url = await begin();
    expect(url.origin).toBe("https://oauth.telegram.org");
    expect(lastFlow!.linkUserId).toBeNull();
  });
});

describe("finishTelegramLogin", () => {
  it("creates a Telegram profile, signs in and sends a new person to /welcome", async () => {
    await expect(roundTrip()).resolves.toBe("/welcome");
    const [u] = rows<{ id: string; telegram_id: string; channel: string }>("SELECT id, telegram_id, channel FROM users");
    expect(u).toMatchObject({ telegram_id: "987654321", channel: "telegram" });
    expect(harness.jar.get(SESSION_COOKIE)).toBeDefined();
    expect(rows("SELECT user_id, method FROM sessions")).toEqual([{ user_id: u.id, method: "telegram" }]);
    expect(rows("SELECT actor, action, target, meta_json FROM audit_log")).toEqual([
      { actor: u.id, action: "auth.login_telegram", target: u.id, meta_json: '{"created":true}' },
    ]);
  });

  it("sends the PKCE verifier from the cookie and the same redirect URI to /token", async () => {
    await roundTrip();
    const body = new URLSearchParams(String(tokenCalls[0].body));
    expect(body.get("code")).toBe("auth-code");
    expect(body.get("code_verifier")).toBe(lastFlow!.verifier);
    expect(body.get("redirect_uri")).toBe(`${ORIGIN}/auth/telegram/callback`);
  });

  it("sends a returning person to /account, or /profile once onboarding is done", async () => {
    exec("INSERT INTO users (id, telegram_id, onboarding_step) VALUES ('u1', '987654321', 'place')");
    await expect(roundTrip()).resolves.toBe("/account");
    exec("UPDATE users SET onboarding_step = 'done' WHERE id = 'u1'");
    harness.jar = (await import("@/test/harness")).fakeCookieJar();
    await expect(roundTrip()).resolves.toBe("/profile");
  });

  it("clears the state cookie so the callback cannot be replayed", async () => {
    const url = await begin();
    await finish({ code: "auth-code", state: url.searchParams.get("state")! });
    expect(harness.jar.store.get(FLOW_COOKIE)).toMatchObject({ value: "", options: { maxAge: 0, secure: true, path: "/" } });
    await expect(finish({ code: "auth-code", state: url.searchParams.get("state")! })).resolves.toBe(
      "/auth/telegram/error?reason=expired",
    );
  });

  it("rejects a state that does not match this browser's cookie (CSRF) before calling Telegram", async () => {
    await begin();
    await expect(finish({ code: "attacker-code", state: "A".repeat(43) })).resolves.toBe(
      "/auth/telegram/error?reason=expired",
    );
    await expect(finish({ code: "attacker-code", state: "x" })).resolves.toBe("/auth/telegram/error?reason=expired");
    expect(tokenCalls).toHaveLength(0);
    expect(rows("SELECT id FROM users")).toEqual([]);
  });

  it("rejects a callback without the state cookie", async () => {
    await expect(finish({ code: "c", state: "A".repeat(43) })).resolves.toBe("/auth/telegram/error?reason=expired");
    expect(tokenCalls).toHaveLength(0);
  });

  it("says the sign-in was cancelled when the person declines in Telegram", async () => {
    const url = await begin();
    await expect(finish({ error: "access_denied", state: url.searchParams.get("state")! })).resolves.toBe(
      "/auth/telegram/error?reason=cancelled",
    );
  });

  it("does not sign in with a token for another client", async () => {
    claimsOver = { aud: "someone-else" };
    await expect(roundTrip()).resolves.toBe("/auth/telegram/error?reason=failed");
    expect(rows("SELECT id FROM users")).toEqual([]);
    expect(harness.jar.get(SESSION_COOKIE)).toBeUndefined();
  });

  it("links Telegram to the signed-in profile when it is free", async () => {
    exec("INSERT INTO users (id, email) VALUES ('u1', 'ada@example.com')");
    await createSession("u1", "email");
    await expect(roundTrip()).resolves.toBe("/account");
    expect(rows("SELECT id, telegram_id, channel FROM users")).toEqual([
      { id: "u1", telegram_id: "987654321", channel: "email" },
    ]);
    expect(rows("SELECT action FROM audit_log")).toEqual([{ action: "auth.telegram_linked" }]);
    // Прив'язка не відкриває нової сесії: сесія поштою лишається сесією поштою.
    expect(rows("SELECT method FROM sessions")).toEqual([{ method: "email" }]);
  });

  it("refuses to link a Telegram that belongs to another profile", async () => {
    exec("INSERT INTO users (id, email) VALUES ('u1', 'ada@example.com')");
    exec("INSERT INTO users (id, telegram_id) VALUES ('u2', '987654321')");
    await createSession("u1", null);
    const sessionBefore = harness.jar.get(SESSION_COOKIE)?.value;
    await expect(roundTrip()).resolves.toBe("/auth/telegram/error?reason=linked_elsewhere");
    expect(rows("SELECT id, telegram_id FROM users ORDER BY id")).toEqual([
      { id: "u1", telegram_id: null },
      { id: "u2", telegram_id: "987654321" },
    ]);
    // Людина лишається у своєму профілі, не в чужому.
    expect(harness.jar.get(SESSION_COOKIE)?.value).toBe(sessionBefore);
  });

  it("does not link or sign in when the session changed during the flow", async () => {
    exec("INSERT INTO users (id, email) VALUES ('u1', 'ada@example.com')");
    await createSession("u1", null);
    const url = await begin();
    harness.jar.delete(SESSION_COOKIE);
    await expect(finish({ code: "c", state: url.searchParams.get("state")! })).resolves.toBe(
      "/auth/telegram/error?reason=session_changed",
    );
    expect(rows("SELECT id, telegram_id FROM users")).toEqual([{ id: "u1", telegram_id: null }]);
  });

  it("does not sign in or link when a session appeared during a signed-out flow", async () => {
    const url = await begin();
    expect(lastFlow!.linkUserId).toBeNull();
    // Поки людина була в Telegram, у цьому браузері хтось увійшов поштою.
    exec("INSERT INTO users (id, email) VALUES ('u1', 'ada@example.com')");
    await createSession("u1", "email");
    const sessionBefore = harness.jar.get(SESSION_COOKIE)?.value;
    await expect(finish({ code: "c", state: url.searchParams.get("state")! })).resolves.toBe(
      "/auth/telegram/error?reason=session_changed",
    );
    expect(rows("SELECT id, telegram_id FROM users")).toEqual([{ id: "u1", telegram_id: null }]);
    expect(harness.jar.get(SESSION_COOKIE)?.value).toBe(sessionBefore);
    expect(rows("SELECT action FROM audit_log")).toEqual([]);
  });

  it("limits code exchanges per IP", async () => {
    for (let i = 0; i < TELEGRAM_CALLBACK_IP_LIMITS.maxAttempts; i++) {
      harness.jar = (await import("@/test/harness")).fakeCookieJar();
      await roundTrip();
    }
    harness.jar = (await import("@/test/harness")).fakeCookieJar();
    await expect(roundTrip()).resolves.toBe("/auth/telegram/error?reason=rate_limited");
  });

  it("shows 'unavailable' when the keys are removed mid-flow", async () => {
    const url = await begin();
    harness.env = { ...harness.env, TELEGRAM_OIDC_CLIENT_SECRET: undefined } as never;
    await expect(finish({ code: "c", state: url.searchParams.get("state")! })).resolves.toBe(
      "/auth/telegram/error?reason=unavailable",
    );
  });
});
