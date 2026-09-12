import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "@/lib/auth/session";
import { exec, RedirectCalled, resetHarness, rows } from "@/test/harness";
import { createCardAction } from "./actions";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/navigation", async () => (await import("@/test/harness")).navigationModule);

function form(role: string, name = "ada"): FormData {
  const data = new FormData();
  data.set("role", role);
  data.set("name", name);
  return data;
}

async function run(p: Promise<unknown>): Promise<unknown> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof RedirectCalled) return err.url;
    throw err;
  }
}

function score(role: string, value: number, reason: string | null = null) {
  exec(
    "INSERT INTO scores (user_id, role, score, breakdown_json, formula_version) VALUES ('u', ?, ?, ?, 'v5')",
    role,
    value,
    JSON.stringify({ reason }),
  );
}

beforeEach(async () => {
  resetHarness();
  exec(`INSERT INTO users (id, email, roles, onboarding_step) VALUES ('u', 'u@example.com', '["engineer","trader","bd"]', 'done')`);
  await createSession("u");
});

describe("createCardAction (a card only with a verified anchor)", () => {
  it("refuses an Engineer card while GitHub is not verified", async () => {
    score("engineer", 55);
    exec("INSERT INTO identities (user_id, kind, value, verify_code) VALUES ('u', 'github', 'ada', 'ncj-aaaaaa')");
    await expect(run(createCardAction({}, form("engineer")))).resolves.toMatchObject({
      message: { tone: "error", text: expect.stringMatching(/Verify your GitHub/) },
    });
    expect(rows("SELECT * FROM cards")).toEqual([]);
  });

  it("creates it once GitHub is verified", async () => {
    score("engineer", 55);
    exec(
      "INSERT INTO identities (user_id, kind, value, verified_via, verified_at) VALUES ('u', 'github', 'ada', 'bio_code', datetime('now'))",
    );
    await expect(run(createCardAction({}, form("engineer")))).resolves.toMatch(/^\/c\/[A-Za-z0-9_-]{10}$/);
  });

  it("refuses a BD card without a verified X, and allows a Trader card without any", async () => {
    score("bd", 40);
    score("trader", 82);
    await expect(run(createCardAction({}, form("bd")))).resolves.toMatchObject({
      message: { text: expect.stringMatching(/Verify your X/) },
    });
    await expect(run(createCardAction({}, form("trader")))).resolves.toMatch(/^\/c\//);
    expect(rows("SELECT role FROM cards")).toEqual([{ role: "trader" }]);
  });
});
