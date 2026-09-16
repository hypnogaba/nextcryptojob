import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomToken, sha256Hex } from "@/lib/auth/hash";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { submitContact } from "@/lib/contact";
import { addUser, crmDb } from "@/test/crm-fixtures";
import { exec, harness, RedirectCalled, resetHarness, rows } from "@/test/harness";
import { setAnsweredAction } from "./actions";
import AdminMessagesPage from "./page";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/navigation", async () => ({
  ...(await import("@/test/harness")).navigationModule,
  notFound: (): never => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

/** /admin/messages (A): захист адміна, і «Mark answered» / «Mark unanswered». */

function setup() {
  resetHarness();
  const { raw, d1 } = crmDb();
  harness.raw = raw;
  harness.env.DB = d1;
}

async function signIn(email: string, method: "email" | "telegram" = "email"): Promise<string> {
  const id = addUser(harness.raw, { email });
  const token = randomToken();
  exec("INSERT INTO sessions (id, user_id, expires_at, method) VALUES (?, ?, datetime('now', '+1 day'), ?)", await sha256Hex(token), id, method);
  harness.jar.set(SESSION_COOKIE, token);
  return id;
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

async function redirectOf(p: Promise<void>): Promise<string> {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(RedirectCalled);
  return (err as RedirectCalled).url;
}

beforeEach(() => setup());

describe("admin guard", () => {
  it("a non-admin cannot mark a message answered, and cannot open the page", async () => {
    await signIn("someone@example.com");
    expect(await redirectOf(setAnsweredAction(form({ id: "msg_x", answered: "1" })))).toBe("/admin/messages?error=not_admin");
    await expect(AdminMessagesPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("the owner signed in through Telegram is not admin", async () => {
    await signIn("owner@example.com", "telegram");
    await expect(AdminMessagesPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("mark answered", () => {
  beforeEach(async () => {
    await signIn("owner@example.com");
  });

  it("lists messages and toggles answered", async () => {
    const res = await submitContact(harness.env.DB, { email: "ada@example.com", topic: "candidate", message: "Hello, how does scoring work?", honeypot: "" });
    if (!res.ok || !res.id) throw new Error("expected an id");

    let html = renderToStaticMarkup(await AdminMessagesPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("ada@example.com");
    expect(html).toContain("Mark answered");

    expect(await redirectOf(setAnsweredAction(form({ id: res.id, answered: "1" })))).toBe("/admin/messages?done=answered");
    expect(rows("SELECT answered_at FROM contact_messages WHERE id = ?", res.id)[0].answered_at).not.toBeNull();

    html = renderToStaticMarkup(await AdminMessagesPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("Mark unanswered");
  });

  it("reports not_found for an unknown message", async () => {
    expect(await redirectOf(setAnsweredAction(form({ id: "msg_doesnotexist00000", answered: "1" })))).toBe("/admin/messages?error=not_found");
  });

  it("shows an empty state when migration 0023 is not applied", async () => {
    const { migratedD1 } = await import("@/test/sqlite-d1");
    const { raw, d1 } = migratedD1();
    harness.raw = raw;
    harness.env.DB = d1;
    await signIn("owner@example.com");
    const html = renderToStaticMarkup(await AdminMessagesPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("migration 0023");
  });
});
