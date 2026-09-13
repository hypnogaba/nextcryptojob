import { beforeEach, describe, expect, it, vi } from "vitest";
import { hmacSha256Hex } from "@/lib/auth/hash";
import { unsubscribeUrl } from "@/lib/digest/unsubscribe";
import { exec, resetHarness, rows, TEST_SECRET } from "@/test/harness";
import { GET, POST } from "./route";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);

const SITE = "https://nextcryptojob.xyz";

beforeEach(() => {
  resetHarness();
  exec("INSERT INTO users (id, email, channel) VALUES ('ada', 'ada@example.com', 'email'), ('bob', 'bob@example.com', 'email')");
});

const paused = () => rows<{ id: string; digest_paused: number }>("SELECT id, digest_paused FROM users ORDER BY id");
const audits = () => rows("SELECT actor, action, target, meta_json FROM audit_log");

describe("/api/digest/unsubscribe", () => {
  it("pauses daily jobs on a one-click POST with a good token, and writes the audit log once", async () => {
    const url = await unsubscribeUrl(SITE, TEST_SECRET, "ada");
    // Так шлють поштові сервіси за RFC 8058.
    const oneClick = () => POST(new Request(url, { method: "POST", body: "List-Unsubscribe=One-Click" }));
    const res = await oneClick();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Daily jobs are paused.");
    expect(paused()).toEqual([{ id: "ada", digest_paused: 1 }, { id: "bob", digest_paused: 0 }]);
    expect(audits()).toEqual([{ actor: "ada", action: "digest.unsubscribe", target: "ada", meta_json: '{"digest_paused":true}' }]);

    // Повтор: знову 200, прапор той самий, другого запису в журналі немає.
    expect((await oneClick()).status).toBe(200);
    expect(paused()[0]).toEqual({ id: "ada", digest_paused: 1 });
    expect(audits()).toHaveLength(1);
  });

  it("refuses a bad token and changes nothing", async () => {
    const good = new URL(await unsubscribeUrl(SITE, TEST_SECRET, "ada"));
    const forged = await hmacSha256Hex("another-key", "unsub:ada");
    const adaToken = good.searchParams.get("t")!;
    for (const query of [`u=ada&t=${forged}`, `u=bob&t=${adaToken}`, "u=ada", `u=ada&t=${adaToken.slice(1)}`, ""]) {
      const res = await POST(new Request(`${SITE}/api/digest/unsubscribe?${query}`, { method: "POST" }));
      expect(res.status).toBe(403);
    }
    expect(paused().every((u) => u.digest_paused === 0)).toBe(true);
    expect(audits()).toEqual([]);
  });

  it("GET shows a page with a Pause daily jobs button and pauses nothing (mail scanners open links)", async () => {
    const url = await unsubscribeUrl(SITE, TEST_SECRET, "ada");
    const res = await GET(new Request(url));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toContain('<form method="post"><button type="submit">Pause daily jobs</button></form>');
    expect(paused()[0]).toEqual({ id: "ada", digest_paused: 0 });
    expect((await GET(new Request(`${SITE}/api/digest/unsubscribe?u=ada&t=${"0".repeat(64)}`))).status).toBe(403);
  });
});
