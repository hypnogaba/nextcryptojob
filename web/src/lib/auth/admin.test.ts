import { beforeEach, describe, expect, it, vi } from "vitest";
import { exec, harness, resetHarness } from "@/test/harness";
import { adminEmails, currentAdmin, isAdminEmail } from "./admin";
import { createSession, SESSION_COOKIE } from "./session";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/navigation", async () => (await import("@/test/harness")).navigationModule);

beforeEach(() => {
  resetHarness({ ADMIN_EMAILS: "boss@example.com" } as never);
  // Та сама людина має і пошту адміна, і Telegram: важить лише, чим вона ввійшла.
  exec("INSERT INTO users (id, email, telegram_id) VALUES ('boss', 'boss@example.com', '555')");
  exec("INSERT INTO users (id, email) VALUES ('ada', 'ada@example.com')");
});

describe("admin list", () => {
  it("reads ADMIN_EMAILS without case and falls back to the owner", () => {
    expect(adminEmails(" Boss@Example.com , x ")).toEqual(["boss@example.com"]);
    expect(adminEmails(undefined)).toEqual(["hypnogaba@gmail.com"]);
    expect(isAdminEmail("BOSS@example.com", "boss@example.com")).toBe(true);
    expect(isAdminEmail(null, "boss@example.com")).toBe(false);
  });
});

describe("currentAdmin", () => {
  it("lets in an admin who signed in with an email code", async () => {
    await createSession("boss", "email");
    await expect(currentAdmin()).resolves.toMatchObject({ id: "boss", method: "email" });
  });

  it("refuses the same admin signed in through Telegram", async () => {
    await createSession("boss", "telegram");
    await expect(currentAdmin()).resolves.toBeNull();
  });

  it("refuses a session from before sign-in methods were recorded", async () => {
    await createSession("boss");
    await expect(currentAdmin()).resolves.toBeNull();
  });

  it("refuses someone who is not on the list, and nobody at all", async () => {
    await createSession("ada", "email");
    await expect(currentAdmin()).resolves.toBeNull();
    harness.jar.delete(SESSION_COOKIE);
    await expect(currentAdmin()).resolves.toBeNull();
  });
});
