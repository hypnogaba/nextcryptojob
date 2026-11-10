import { AuthorizationError, type ConsentDescription, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/lib/auth/hash";
import { addUser, crmDb, run } from "@/test/crm-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { consentHtml, handleAuthorize, readCookie } from "./authorize";

/** Сторінка згоди конектора: вхід через сесію сайту, екранування всього від клієнта, Allow і Deny. */

let t: TestDb;
const TOKEN = "A".repeat(43);

const details: ConsentDescription = {
  clientName: `<script>alert(1)</script>Claude`,
  clientDomain: "claude.ai",
  redirectHost: "claude.ai",
  redirectIsLoopback: false,
  scope: ["jobs"],
} as unknown as ConsentDescription;

function fakeOAuth(over: Partial<OAuthHelpers> = {}) {
  const calls: Record<string, unknown[]> = {};
  const spy = <T>(name: string, value: T) =>
    vi.fn(async (...args: unknown[]) => {
      calls[name] = args;
      return value;
    });
  const helpers = {
    parseAuthRequest: spy("parseAuthRequest", { clientId: "c", scope: ["jobs"] }),
    describeConsent: spy("describeConsent", details),
    beginConsent: spy("beginConsent", { handle: "h1", headers: new Headers({ "X-Frame-Options": "DENY" }) }),
    approveConsent: spy("approveConsent", { request: { clientId: "c", scope: ["jobs"] }, headers: new Headers() }),
    denyConsent: spy("denyConsent", { headers: new Headers({ Location: "https://claude.ai/cb?error=access_denied" }) }),
    completeAuthorization: spy("completeAuthorization", { redirectTo: "https://claude.ai/cb?code=x" }),
    ...over,
  } as unknown as OAuthHelpers;
  return { helpers, calls };
}

async function signedIn(): Promise<string> {
  const id = addUser(t.raw, { email: "ada@example.com" });
  run(t.raw, "INSERT INTO sessions (id, user_id, expires_at, method) VALUES (?, ?, datetime('now', '+1 day'), 'email')", await sha256Hex(TOKEN), id);
  return id;
}

const URL_ = "https://nextcryptojob.xyz/oauth/authorize?client_id=c&state=s";

beforeEach(() => {
  t = crmDb();
});

describe("GET /oauth/authorize", () => {
  it("sends a visitor without a session to /login and back to this same request", async () => {
    const { helpers } = fakeOAuth();
    const res = await handleAuthorize(new Request(URL_), { DB: t.d1, OAUTH_PROVIDER: helpers });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/login?next=${encodeURIComponent("/oauth/authorize?client_id=c&state=s")}`);
  });

  it("checks the request before anything else: a bad client never reaches the login page", async () => {
    const { helpers } = fakeOAuth({
      parseAuthRequest: vi.fn(async () => {
        throw new AuthorizationError("invalid_request" as never, { description: "Unknown client <b>x</b>" } as never);
      }) as never,
    });
    const res = await handleAuthorize(new Request(URL_), { DB: t.d1, OAUTH_PROVIDER: helpers });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("<b>x</b>");
  });

  it("shows the consent page with the person, escaped client name and no framing", async () => {
    await signedIn();
    const { helpers } = fakeOAuth();
    const res = await handleAuthorize(new Request(URL_, { headers: { cookie: `x=1; ncj_session=${TOKEN}` } }), { DB: t.d1, OAUTH_PROVIDER: helpers });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    const html = await res.text();
    expect(html).toContain("ada@example.com");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&#60;script&#62;");
    expect(html).toContain('name="handle" value="h1"');
  });

  it("an expired session is no session", async () => {
    const id = addUser(t.raw, { email: "old@example.com" });
    run(t.raw, "INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '-1 day'))", await sha256Hex(TOKEN), id);
    const { helpers } = fakeOAuth();
    const res = await handleAuthorize(new Request(URL_, { headers: { cookie: `ncj_session=${TOKEN}` } }), { DB: t.d1, OAUTH_PROVIDER: helpers });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toMatch(/^\/login\?next=/);
  });
});

describe("POST /oauth/authorize", () => {
  const post = (decision: string, cookie = `ncj_session=${TOKEN}`) =>
    new Request(URL_, { method: "POST", headers: { cookie }, body: new URLSearchParams({ handle: "h1", decision }) });

  it("Allow grants the signed-in person, with props holding only their id", async () => {
    const id = await signedIn();
    const { helpers, calls } = fakeOAuth();
    const res = await handleAuthorize(post("approve"), { DB: t.d1, OAUTH_PROVIDER: helpers });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://claude.ai/cb?code=x");
    expect(calls.approveConsent[1]).toBe("h1");
    expect(calls.completeAuthorization[0]).toMatchObject({ userId: id, props: { userId: id } });
  });

  it("Deny goes back to the app with access_denied and grants nothing", async () => {
    await signedIn();
    const { helpers, calls } = fakeOAuth();
    const res = await handleAuthorize(post("deny"), { DB: t.d1, OAUTH_PROVIDER: helpers });
    expect(res.headers.get("Location")).toContain("access_denied");
    expect(calls.completeAuthorization).toBeUndefined();
  });

  it("without a session nothing is granted", async () => {
    const { helpers, calls } = fakeOAuth();
    const res = await handleAuthorize(post("approve", ""), { DB: t.d1, OAUTH_PROVIDER: helpers });
    expect(res.status).toBe(401);
    expect(calls.completeAuthorization).toBeUndefined();
  });
});

describe("helpers", () => {
  it("readCookie finds the exact name only", () => {
    expect(readCookie("a=1; ncj_session_x=2; ncj_session=3", "ncj_session")).toBe("3");
    expect(readCookie(null, "ncj_session")).toBeNull();
  });

  it("warns when access goes to an app on this computer", () => {
    const html = consentHtml({ ...details, redirectIsLoopback: true } as ConsentDescription, "h", { id: "u", email: null, channel: "telegram", tg: "ada" });
    expect(html).toContain("an app on your computer");
    expect(html).toContain("@ada on Telegram");
  });
});
