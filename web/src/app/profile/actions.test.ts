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
  await createSession("u", null);
});

describe("createCardAction (trust model of 13.09: self-reported sources are enough)", () => {
  it("creates an Engineer card with a GitHub the person only typed in", async () => {
    score("engineer", 55);
    exec("INSERT INTO identities (user_id, kind, value) VALUES ('u', 'github', 'ada')");
    await expect(run(createCardAction({}, form("engineer")))).resolves.toMatch(/^\/c\/[A-Za-z0-9_-]{10}$/);
  });

  it("one card per person (item 7): a card for another role revokes the previous one and redirects its old address", async () => {
    score("bd", 40);
    score("trader", 82);
    exec("INSERT INTO identities (user_id, kind, value) VALUES ('u', 'x', 'ada')");
    const first = await run(createCardAction({}, form("bd")));
    expect(first).toMatch(/^\/c\//);
    const firstSlug = (first as string).slice(3);
    const second = await run(createCardAction({}, form("trader")));
    expect(second).toMatch(/^\/c\//);
    const secondSlug = (second as string).slice(3);

    // Лише одна активна картка, роль trader (остання видана).
    expect(rows("SELECT role, revoked_at IS NOT NULL AS revoked FROM cards ORDER BY role")).toEqual([
      { role: "bd", revoked: 1 },
      { role: "trader", revoked: 0 },
    ]);
    // Стара адреса /c/<bd-slug> веде на нову.
    expect(rows("SELECT redirect_to FROM cards WHERE slug = ?", firstSlug)).toEqual([{ redirect_to: secondSlug }]);
  });

  it("still refuses a role without a score, a role the person did not pick, and an unknown role", async () => {
    score("community", 30);
    await expect(run(createCardAction({}, form("engineer")))).resolves.toMatchObject({
      message: { text: "There is no score for this role yet." },
    });
    await expect(run(createCardAction({}, form("community")))).resolves.toMatchObject({
      message: { text: "There is no score for this role yet." },
    });
    await expect(run(createCardAction({}, form("bogus")))).resolves.toMatchObject({ message: { text: "Unknown role." } });
    expect(rows("SELECT * FROM cards")).toEqual([]);
  });
});
