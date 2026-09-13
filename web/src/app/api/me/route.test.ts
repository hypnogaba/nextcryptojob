import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetSettingsCache } from "@/lib/admin/settings";
import { createSession } from "@/lib/auth/session";
import { exec, resetHarness } from "@/test/harness";
import { GET } from "./route";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);

/** /api/me: стан входу для статичної шапки й повідомлення на весь сайт з /admin/settings. */

beforeEach(() => {
  resetSettingsCache();
  resetHarness();
  exec("INSERT INTO users (id, email) VALUES ('ada', 'ada@example.com')");
});

describe("GET /api/me", () => {
  it("says who is signed in, never caches, and has no notice by default", async () => {
    const res = await GET();
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await res.json()).toEqual({ signedIn: false, notice: null });
    await createSession("ada", "email");
    expect(await (await GET()).json()).toEqual({ signedIn: true, notice: null });
  });

  it("carries the site notice as plain text with its style, and nothing else about the person", async () => {
    exec(`INSERT INTO app_settings (key, value_json) VALUES ('banner_message', '"Digests are late today."'), ('banner_level', '"warning"')`);
    await createSession("ada", "email");
    const body = await (await GET()).json();
    expect(body).toEqual({ signedIn: true, notice: { message: "Digests are late today.", level: "warning" } });
    expect(JSON.stringify(body)).not.toContain("ada");
  });
});
