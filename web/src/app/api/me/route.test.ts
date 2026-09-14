import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetSettingsCache } from "@/lib/admin/settings";
import { createSession } from "@/lib/auth/session";
import { exec, harness, resetHarness } from "@/test/harness";
import { GET } from "./route";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);

/** /api/me: стан входу для статичної шапки, пункт «Admin», повідомлення на весь сайт, і лічильник переглядів. */

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

function request(query = "", headers: Record<string, string> = {}): Request {
  return new Request(`https://nextcryptojob.xyz/api/me${query}`, {
    headers: { "user-agent": CHROME, "cf-connecting-ip": "203.0.113.7", ...headers },
  });
}

const rows = () => harness.raw.prepare("SELECT day, path_group, ref_host, views, uniques FROM visit_days ORDER BY path_group, ref_host").all();

beforeEach(() => {
  resetSettingsCache();
  resetHarness({ ADMIN_EMAILS: "boss@example.com" } as never);
  exec("INSERT INTO users (id, email) VALUES ('ada', 'ada@example.com')");
  exec("INSERT INTO users (id, email) VALUES ('boss', 'boss@example.com')");
});

describe("GET /api/me", () => {
  it("says who is signed in, never caches, and has no notice by default", async () => {
    const res = await GET(request());
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await res.json()).toEqual({ signedIn: false, admin: false, notice: null });
    await createSession("ada", "email");
    expect(await (await GET(request())).json()).toEqual({ signedIn: true, admin: false, notice: null });
  });

  it("says admin only for an admin email signed in by email, so the header can show Admin", async () => {
    await createSession("boss", "email");
    expect(await (await GET(request())).json()).toMatchObject({ signedIn: true, admin: true });
    await createSession("boss", "telegram");
    expect(await (await GET(request())).json()).toMatchObject({ signedIn: true, admin: false });
  });

  it("carries the site notice as plain text with its style, and nothing else about the person", async () => {
    exec(`INSERT INTO app_settings (key, value_json) VALUES ('banner_message', '"Digests are late today."'), ('banner_level', '"warning"')`);
    await createSession("ada", "email");
    const body = await (await GET(request())).json();
    expect(body).toEqual({ signedIn: true, admin: false, notice: { message: "Digests are late today.", level: "warning" } });
    expect(JSON.stringify(body)).not.toContain("ada");
  });
});

describe("page views through /api/me", () => {
  it("counts a view and a new visitor once a day, with the path group and the referrer host", async () => {
    await GET(request("?v=%2Fjobs%2Fj123&r=https%3A%2F%2Fwww.google.com%2Fsearch%3Fq%3Dcrypto"));
    await GET(request("?v=%2Fjobs&n=1"));
    await GET(request("?v=%2F&n=1"));
    const day = new Date().toISOString().slice(0, 10);
    expect(rows()).toEqual([
      { day, path_group: "home", ref_host: "", views: 1, uniques: 0 },
      { day, path_group: "jobs", ref_host: "", views: 1, uniques: 0 },
      { day, path_group: "jobs", ref_host: "google.com", views: 1, uniques: 1 },
    ]);
    // Інший браузер з тієї самої IP: новий відвідувач.
    await GET(request("?v=%2F", { "user-agent": `${CHROME} Edg/140.0` }));
    expect(harness.raw.prepare("SELECT SUM(uniques) AS u, SUM(views) AS v FROM visit_days").get()).toEqual({ u: 2, v: 4 });
  });

  it("never stores the IP or the user agent, only a salted hash", async () => {
    await GET(request("?v=%2F"));
    const dump = JSON.stringify([
      harness.raw.prepare("SELECT * FROM visit_visitors").all(),
      harness.raw.prepare("SELECT * FROM visit_days").all(),
    ]);
    expect(dump).not.toContain("203.0.113.7");
    expect(dump).not.toContain("Chrome");
    const [row] = harness.raw.prepare("SELECT hash FROM visit_visitors").all() as { hash: string }[];
    expect(row.hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("skips bots, admin views, admin pages and requests without a page", async () => {
    await GET(request("?v=%2F", { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" }));
    await GET(request("?v=%2F", { "user-agent": "Mozilla/5.0 HeadlessChrome/140.0" }));
    await GET(request("?v=%2Fadmin%2Fsources"));
    await GET(request());
    await createSession("boss", "email");
    await GET(request("?v=%2Fjobs"));
    await createSession("boss", "telegram");
    await GET(request("?v=%2Fjobs"));
    expect(rows()).toEqual([]);
  });
});
