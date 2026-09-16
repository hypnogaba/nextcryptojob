import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomToken, sha256Hex } from "@/lib/auth/hash";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { addUser, crmDb, run } from "@/test/crm-fixtures";
import { exec, harness, resetHarness } from "@/test/harness";
import AdminFunnelPage from "./page";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/navigation", async () => ({
  ...(await import("@/test/harness")).navigationModule,
  notFound: (): never => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

/** /admin/funnel (D): захист адміна, перемикач вікон, і що сторінка рендерить кроки. */

function setup() {
  resetHarness();
  const { raw, d1 } = crmDb();
  harness.raw = raw;
  harness.env.DB = d1;
}

async function signIn(email: string): Promise<void> {
  const id = addUser(harness.raw, { email });
  const token = randomToken();
  exec("INSERT INTO sessions (id, user_id, expires_at, method) VALUES (?, ?, datetime('now', '+1 day'), 'email')", await sha256Hex(token), id);
  harness.jar.set(SESSION_COOKIE, token);
}

beforeEach(() => setup());

describe("admin guard", () => {
  it("a non-admin cannot open the funnel page", async () => {
    await signIn("someone@example.com");
    await expect(AdminFunnelPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("steps", () => {
  it("shows every funnel step and switches window on ?window=", async () => {
    await signIn("owner@example.com");
    run(harness.raw, "INSERT INTO funnel_days (day, step, count) VALUES (?, 'brief_started', 3)", new Date().toISOString().slice(0, 10));
    const html = renderToStaticMarkup(await AdminFunnelPage({ searchParams: Promise.resolve({ window: "30" }) }));
    for (const label of ["Visitors", "Brief started", "X added", "Wallet added", "Score ready", "Card viewed", "Share on X click", "Digest active", "Apply clicks"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('aria-current="page"');
  });
});
