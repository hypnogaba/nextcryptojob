import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomToken, sha256Hex } from "@/lib/auth/hash";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { addUser, crmDb, run } from "@/test/crm-fixtures";
import { exec, harness, resetHarness } from "@/test/harness";
import AdminCandidatesPage from "./page";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/navigation", async () => ({
  ...(await import("@/test/harness")).navigationModule,
  notFound: (): never => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

/** /admin/candidates (п.17, 15.09: власник не знайшов розбір балу людини з адмінки). */

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
  it("a non-admin cannot open the candidates page", async () => {
    await signIn("someone@example.com");
    await expect(AdminCandidatesPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("candidates list", () => {
  it("each person links to /admin/scores/<id>, newest first, search visible at the top", async () => {
    await signIn("hypnogaba@gmail.com");
    const ada = addUser(harness.raw, { email: "ada@example.com" });
    run(
      harness.raw,
      `INSERT INTO scores (user_id, role, score, core, cover, breakdown_json, formula_version, computed_at)
       VALUES (?, 'engineer', 71, 70, 80, '{"cover":80,"level":8}', 'v6', '2026-09-15 10:00:00')`,
      ada,
    );
    const html = renderToStaticMarkup(await AdminCandidatesPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain(`href="/admin/scores/${ada}"`);
    expect(html).toContain("ada@example.com");
    // Пошук зверху, до таблиці.
    expect(html.indexOf("Search by email")).toBeLessThan(html.indexOf("<table"));
    expect(html).toContain('aria-current="page"');
  });

  it("filters by the ?q= search term", async () => {
    await signIn("hypnogaba@gmail.com");
    addUser(harness.raw, { email: "ada@example.com" });
    addUser(harness.raw, { email: "bob@example.com" });
    const html = renderToStaticMarkup(await AdminCandidatesPage({ searchParams: Promise.resolve({ q: "ada" }) }));
    expect(html).toContain("ada@example.com");
    expect(html).not.toContain("bob@example.com");
  });
});
