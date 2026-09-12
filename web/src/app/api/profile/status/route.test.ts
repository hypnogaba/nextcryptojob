import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "@/lib/auth/session";
import { exec, harness, resetHarness } from "@/test/harness";
import { GET } from "./route";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/navigation", async () => (await import("@/test/harness")).navigationModule);

beforeEach(() => {
  resetHarness();
  exec("INSERT INTO users (id, email) VALUES ('me', 'me@example.com'), ('them', 'them@example.com')");
  exec("INSERT INTO score_jobs (user_id, reason, status) VALUES ('them', 'connect', 'failed')");
  exec("INSERT INTO score_jobs (user_id, reason, status) VALUES ('me', 'connect', 'queued')");
  exec("INSERT INTO score_jobs (user_id, reason, status) VALUES ('them', 'manual', 'running')");
  exec(
    "INSERT INTO scores (user_id, role, score, breakdown_json, formula_version) VALUES ('them', 'bd', 61, '{}', 'v5')",
  );
});

describe("GET /api/profile/status", () => {
  it("refuses without a session", async () => {
    const res = await GET();
    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("returns only the caller's job and scores, and nothing personal", async () => {
    await createSession("me");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await res.json();
    expect(body).toEqual({
      job: { status: "queued", waitedSeconds: expect.any(Number) },
      scored: false,
      sourcesChanged: false,
    });
    expect(JSON.stringify(body)).not.toMatch(/me@example|them|"me"/);
  });

  it("gives the other person their own state", async () => {
    await createSession("them");
    expect(await (await GET()).json()).toMatchObject({ job: { status: "running" }, scored: true });
    expect(harness.jar.store.size).toBe(1);
  });
});
