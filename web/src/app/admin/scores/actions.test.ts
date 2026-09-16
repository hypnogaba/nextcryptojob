import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomToken, sha256Hex } from "@/lib/auth/hash";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { addUser, crmDb, run, setConsent } from "@/test/crm-fixtures";
import { exec, harness, RedirectCalled, resetHarness, rows } from "@/test/harness";
import { rescoreNowAction } from "./actions";
import AdminScoresPage from "./page";
import AdminScoreDetailPage from "./[userId]/page";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/navigation", async () => ({
  ...(await import("@/test/harness")).navigationModule,
  notFound: (): never => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

/** /admin/scores і /admin/scores/[userId] (C): захист адміна і «Rescore now». */

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
  it("a non-admin cannot rescore, and cannot open either page", async () => {
    await signIn("someone@example.com");
    expect(await redirectOf(rescoreNowAction(form({ user_id: "u1" })))).toBe("/admin/scores/u1?error=not_admin");
    await expect(AdminScoresPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(
      AdminScoreDetailPage({ params: Promise.resolve({ userId: "u1" }), searchParams: Promise.resolve({}) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("rescore now", () => {
  beforeEach(async () => {
    await signIn("owner@example.com");
  });

  it("queues a score job for a person with consent, same as their own Update my score", async () => {
    const candidate = addUser(harness.raw, { id: "u1", email: "ada@example.com" });
    setConsent(harness.raw, candidate, "scoring", true);

    expect(await redirectOf(rescoreNowAction(form({ user_id: candidate })))).toBe(`/admin/scores/${candidate}?done=queued`);
    expect(rows("SELECT user_id, reason, status FROM score_jobs")).toEqual([{ user_id: candidate, reason: "manual", status: "queued" }]);

    const html = renderToStaticMarkup(
      await AdminScoreDetailPage({ params: Promise.resolve({ userId: candidate }), searchParams: Promise.resolve({ done: "queued" }) }),
    );
    expect(html).toContain("Queued");
  });

  it("reports no_consent for a person without scoring consent", async () => {
    const candidate = addUser(harness.raw, { id: "u2", email: "bob@example.com" });
    run(harness.raw, "DELETE FROM consents WHERE user_id = ?", candidate);
    expect(await redirectOf(rescoreNowAction(form({ user_id: candidate })))).toBe(`/admin/scores/${candidate}?error=no_consent`);
  });

  it("404s the detail page for an unknown user id", async () => {
    await expect(
      AdminScoreDetailPage({ params: Promise.resolve({ userId: "nope" }), searchParams: Promise.resolve({}) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
