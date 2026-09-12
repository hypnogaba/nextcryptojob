import { beforeEach, describe, expect, it, vi } from "vitest";
import { RedirectCalled, exec, harness, resetHarness, rows } from "@/test/harness";
import { sha256Hex } from "./hash";
import {
  SESSION_COOKIE,
  createSession,
  currentUser,
  requireUser,
  signOut,
} from "./session";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/navigation", async () => (await import("@/test/harness")).navigationModule);

const SQL_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function addUser(id = "u1", email = "ada@example.com") {
  exec("INSERT INTO users (id, email) VALUES (?, ?)", id, email);
}

function token(): string {
  const c = harness.jar.store.get(SESSION_COOKIE);
  if (!c) throw new Error("no session cookie");
  return c.value;
}

beforeEach(() => resetHarness());

describe("createSession", () => {
  it("sets a random HttpOnly, Secure, SameSite=Lax cookie for 30 days", async () => {
    addUser();
    await createSession("u1");
    const cookie = harness.jar.store.get(SESSION_COOKIE);
    expect(cookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie?.options).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });
  });

  it("stores only the SHA-256 of the token, never the token", async () => {
    addUser();
    await createSession("u1");
    const all = rows("SELECT * FROM sessions");
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(await sha256Hex(token()));
    expect(JSON.stringify(all)).not.toContain(token());
  });

  it("expires in 30 days, written as SQLite time", async () => {
    addUser();
    await createSession("u1");
    const [row] = rows<{ expires_at: string; days: number }>(
      "SELECT expires_at, julianday(expires_at) - julianday('now') AS days FROM sessions",
    );
    expect(row.expires_at).toMatch(SQL_TIME);
    expect(row.days).toBeGreaterThan(29.99);
    expect(row.days).toBeLessThanOrEqual(30);
  });

  it("gives each sign-in its own token", async () => {
    addUser();
    await createSession("u1");
    const first = token();
    await createSession("u1");
    expect(token()).not.toBe(first);
    expect(rows("SELECT id FROM sessions")).toHaveLength(2);
  });

  it("clears the person's expired sessions", async () => {
    addUser();
    exec("INSERT INTO sessions (id, user_id, expires_at) VALUES ('old', 'u1', datetime('now', '-1 day'))");
    await createSession("u1");
    expect(rows("SELECT id FROM sessions WHERE id = 'old'")).toHaveLength(0);
  });
});

describe("currentUser", () => {
  it("is null without a cookie", async () => {
    await expect(currentUser()).resolves.toBeNull();
  });

  it("returns the person behind the cookie", async () => {
    addUser();
    await createSession("u1");
    await expect(currentUser()).resolves.toEqual({ id: "u1", email: "ada@example.com", channel: "email", method: null });
  });

  it.each(["email", "telegram"] as const)("says the session was opened by %s", async (method) => {
    addUser();
    await createSession("u1", method);
    expect(rows("SELECT method FROM sessions")).toEqual([{ method }]);
    await expect(currentUser()).resolves.toMatchObject({ id: "u1", method });
  });

  it("rejects a token that is not in the database", async () => {
    addUser();
    await createSession("u1");
    harness.jar.set(SESSION_COOKIE, "A".repeat(43));
    await expect(currentUser()).resolves.toBeNull();
  });

  it("rejects the stored hash used as a cookie", async () => {
    addUser();
    await createSession("u1");
    harness.jar.set(SESSION_COOKIE, await sha256Hex(token()));
    await expect(currentUser()).resolves.toBeNull();
  });

  it("rejects an expired session", async () => {
    addUser();
    await createSession("u1");
    exec("UPDATE sessions SET expires_at = datetime('now', '-1 second')");
    await expect(currentUser()).resolves.toBeNull();
  });

  it("updates last_active_at when it is older than an hour", async () => {
    addUser();
    await createSession("u1");
    exec("UPDATE users SET last_active_at = datetime('now', '-2 hours')");
    await currentUser();
    const [row] = rows<{ age: number }>(
      "SELECT (julianday('now') - julianday(last_active_at)) * 86400 AS age FROM users",
    );
    expect(row.age).toBeLessThan(5);
  });

  it("leaves last_active_at alone within the hour", async () => {
    addUser();
    await createSession("u1");
    exec("UPDATE users SET last_active_at = datetime('now', '-10 minutes')");
    const [before] = rows<{ last_active_at: string }>("SELECT last_active_at FROM users");
    await currentUser();
    const [after] = rows<{ last_active_at: string }>("SELECT last_active_at FROM users");
    expect(after.last_active_at).toBe(before.last_active_at);
  });
});

describe("requireUser", () => {
  it("sends a signed-out visitor to /login", async () => {
    await expect(requireUser()).rejects.toEqual(new RedirectCalled("/login"));
  });

  it("returns the signed-in person", async () => {
    addUser();
    await createSession("u1");
    await expect(requireUser()).resolves.toMatchObject({ id: "u1" });
  });
});

describe("signOut", () => {
  it("deletes the session row and the cookie", async () => {
    addUser();
    await createSession("u1");
    const stale = token();
    await signOut();
    expect(harness.jar.store.has(SESSION_COOKIE)).toBe(false);
    expect(rows("SELECT id FROM sessions")).toHaveLength(0);

    // Старий токен, збережений деінде, більше нічого не відкриває.
    harness.jar.set(SESSION_COOKIE, stale);
    await expect(currentUser()).resolves.toBeNull();
  });

  it("only closes the current session", async () => {
    addUser();
    await createSession("u1");
    await createSession("u1");
    await signOut();
    expect(rows("SELECT id FROM sessions")).toHaveLength(1);
  });
});
