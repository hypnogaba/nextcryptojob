import { beforeEach, describe, expect, it, vi } from "vitest";
import { stillLookingUrl } from "@/lib/nudges/still-looking";
import { exec, resetHarness, rows, TEST_SECRET } from "@/test/harness";
import { GET, POST } from "./route";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);

const SITE = "https://nextcryptojob.xyz";

beforeEach(() => {
  resetHarness();
  exec("INSERT INTO users (id, email, channel, last_active_at) VALUES ('ada', 'ada@example.com', 'email', '2026-08-01 00:00:00')");
  exec("INSERT INTO nudges (user_id, kind, channel) VALUES ('ada', 'still_looking', 'email')");
});

describe("/api/digest/still-looking (Yes in the email)", () => {
  it("GET shows a button and changes nothing", async () => {
    const res = await GET(new Request(await stillLookingUrl(SITE, TEST_SECRET, "ada")));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Yes, keep them coming");
    expect(rows<{ answered_at: string | null }>("SELECT answered_at FROM nudges")[0]!.answered_at).toBeNull();
  });

  it("POST answers the question and counts as activity", async () => {
    const res = await POST(new Request(await stillLookingUrl(SITE, TEST_SECRET, "ada"), { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("keep coming");
    expect(rows<{ answered_at: string | null }>("SELECT answered_at FROM nudges")[0]!.answered_at).not.toBeNull();
    expect(rows<{ a: string }>("SELECT last_active_at AS a FROM users")[0]!.a > "2026-09-01").toBe(true);
  });

  it("refuses a bad signature", async () => {
    const good = new URL(await stillLookingUrl(SITE, TEST_SECRET, "ada"));
    good.searchParams.set("u", "bob");
    expect((await POST(new Request(good, { method: "POST" }))).status).toBe(403);
    expect(rows<{ answered_at: string | null }>("SELECT answered_at FROM nudges")[0]!.answered_at).toBeNull();
  });
});
