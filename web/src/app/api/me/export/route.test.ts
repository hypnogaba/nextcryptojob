import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "@/lib/auth/session";
import { exec, harness, resetHarness, rows } from "@/test/harness";
import { GET } from "./route";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/navigation", async () => (await import("@/test/harness")).navigationModule);

beforeEach(() => {
  resetHarness();
  exec("INSERT INTO users (id, email) VALUES ('me', 'me@example.com'), ('them', 'them@example.com')");
});

describe("GET /api/me/export", () => {
  it("refuses without a session", async () => {
    expect((await GET()).status).toBe(401);
  });

  it("allows 10 downloads an hour per person, then answers 429 with Retry-After", async () => {
    await createSession("me");
    for (let i = 0; i < 10; i++) expect((await GET()).status).toBe(200);
    const res = await GET();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("3600");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await res.json()).toEqual({ error: "Too many downloads. Try again in 60 minutes." });
    expect(rows("SELECT key FROM auth_attempts")).toEqual([{ key: "export:me" }]);

    // Лічильник свій у кожної людини.
    harness.jar.store.clear();
    await createSession("them");
    expect((await GET()).status).toBe(200);
  });
});
