import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "@/lib/auth/session";
import { ensureKeyVersion, profileKey } from "@/lib/card/profile-prefs";
import { createCard } from "@/lib/card/store";
import { exec, harness, resetHarness } from "@/test/harness";
import { GET } from "./route";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/navigation", async () => (await import("@/test/harness")).navigationModule);

let slug = "";
const get = (query = "") =>
  GET(new Request(`https://nextcryptojob.xyz/c/${slug}/profile.pdf${query}`), { params: Promise.resolve({ slug }) });

beforeEach(async () => {
  resetHarness();
  harness.headers = new Headers({ host: "nextcryptojob.xyz" });
  exec("INSERT INTO users (id, email, roles) VALUES ('u', 'u@example.com', '[\"bd\"]'), ('v', 'v@example.com', '[]')");
  exec("INSERT INTO scores (user_id, role, score, breakdown_json, formula_version) VALUES ('u', 'bd', 44, '{}', 'v6')");
  slug = await createCard(harness.env.DB, { userId: "u", role: "bd", score: 44, displayName: "ada", formulaVersion: "v6" });
});

describe("GET /c/<slug>/profile.pdf", () => {
  it("is 404 without a key or with someone else's session", async () => {
    expect((await get()).status).toBe(404);
    expect((await get(`?k=${"0".repeat(32)}`)).status).toBe(404);
    await createSession("v", null);
    expect((await get()).status).toBe(404);
  });

  it("is 404 before the owner created a key, even with the would-be key", async () => {
    expect((await get(`?k=${await profileKey(harness.env.SESSION_SECRET!, "u", 1)}`)).status).toBe(404);
  });

  it("gives the PDF with the current key or to the owner", async () => {
    await ensureKeyVersion(harness.env.DB, "u");
    const res = await get(`?k=${await profileKey(harness.env.SESSION_SECRET!, "u", 1)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(new TextDecoder().decode((await res.arrayBuffer()).slice(0, 5))).toBe("%PDF-");

    await createSession("u", null);
    expect((await get()).status).toBe(200);
  });

  it("is 404 for an unknown card", async () => {
    slug = "zzzzzzzzzz";
    expect((await get()).status).toBe(404);
  });
});
