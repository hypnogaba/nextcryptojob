import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSingleIdentity } from "@/lib/identity/store";
import { migratedD1, type TestDb } from "@/test/sqlite-d1";
import { CHECK_LIMITS, checkIdentity } from "./check";

let t: TestDb;
const CODE = "ncj-k7qx2a";

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | Error;

/** Замінник fetch: відповіді по черзі, запити записуються. */
function stubFetch(...replies: Reply[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const reply = replies.shift();
    if (!reply) throw new Error("unexpected fetch");
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: reply.headers });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const xInfo = (description: string, screenName = "Ada") => ({
  body: { success: true, data: { screenName, description, followersCount: 1 } },
});
const xPosts = (...texts: string[]) => ({
  body: {
    success: true,
    data: texts.map((text, i) => ({ id: String(i), conversationId: String(i), text, userScreenName: "ada" })),
  },
});

function row() {
  return { ...t.raw.prepare("SELECT verified_via, verified_at, verify_code FROM identities WHERE user_id = 'a'").get() };
}

beforeEach(async () => {
  t = migratedD1();
  t.raw.exec("INSERT INTO users (id, email) VALUES ('a', 'a@example.com')");
});

describe("checkIdentity for X", () => {
  beforeEach(async () => {
    await setSingleIdentity(t.d1, "a", "x", "ada", CODE);
  });

  it("verifies by the code in the bio without reading posts", async () => {
    const f = stubFetch(xInfo(`frog ${CODE}`));
    await expect(checkIdentity(t.d1, "a", "x", { twitterToken: "tok", fetch: f.impl })).resolves.toEqual({
      status: "verified",
      via: "bio_code",
    });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe("https://ai.6551.io/open/twitter_user_info");
    expect(f.calls[0].init?.headers).toMatchObject({ Authorization: "Bearer tok" });
    expect(JSON.parse(String(f.calls[0].init?.body))).toEqual({ username: "ada" });
    expect(row()).toMatchObject({ verified_via: "bio_code", verify_code: null });
    expect(row().verified_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("verifies by the code in a recent post", async () => {
    const f = stubFetch(xInfo("no code here"), xPosts("gm", `verifying ${CODE}`));
    await expect(checkIdentity(t.d1, "a", "x", { twitterToken: "tok", fetch: f.impl })).resolves.toEqual({
      status: "verified",
      via: "post_code",
    });
    expect(JSON.parse(String(f.calls[1].init?.body))).toEqual({ username: "ada", maxResults: 20, product: "Latest" });
    expect(row().verified_via).toBe("post_code");
  });

  it("says the code is missing when neither the bio nor posts have it", async () => {
    const f = stubFetch(xInfo("nothing"), xPosts("gm", "ncj-aaaaaa"));
    await expect(checkIdentity(t.d1, "a", "x", { twitterToken: "tok", fetch: f.impl })).resolves.toEqual({
      status: "code_missing",
    });
    expect(row().verified_at).toBeNull();
  });

  it("ignores posts by other accounts", async () => {
    const f = stubFetch(xInfo("nothing"), {
      body: { data: [{ id: "1", text: CODE, userScreenName: "someone_else" }] },
    });
    await expect(checkIdentity(t.d1, "a", "x", { twitterToken: "tok", fetch: f.impl })).resolves.toEqual({
      status: "code_missing",
    });
  });

  it("does not count a retweet or a reply that carries the code", async () => {
    const f = stubFetch(xInfo("nothing"), {
      body: {
        data: [
          { id: "1", conversationId: "1", text: `RT @attacker: grab ${CODE}`, userScreenName: "ada" },
          { id: "2", conversationId: "99", text: `@attacker ${CODE}`, userScreenName: "ada" },
          { id: "3", conversationId: "3", text: "gm", userScreenName: "ada" },
        ],
      },
    });
    await expect(checkIdentity(t.d1, "a", "x", { twitterToken: "tok", fetch: f.impl })).resolves.toEqual({
      status: "code_missing",
    });
    expect(row().verified_at).toBeNull();
  });

  it("counts an own post, with or without conversation ids", async () => {
    const f = stubFetch(xInfo("nothing"), {
      body: { data: [{ id: "7", conversationId: "7", text: `proof ${CODE}`, userScreenName: "ada" }] },
    });
    await expect(checkIdentity(t.d1, "a", "x", { twitterToken: "tok", fetch: f.impl })).resolves.toMatchObject({
      status: "verified",
      via: "post_code",
    });
  });

  it("treats an empty post list from 6551 as busy", async () => {
    const f = stubFetch(xInfo("nothing"), { body: { success: true, data: [] } });
    await expect(checkIdentity(t.d1, "a", "x", { twitterToken: "tok", fetch: f.impl })).resolves.toEqual({
      status: "busy",
    });
  });

  it("treats empty data from 6551 as busy, not as a failure", async () => {
    const f = stubFetch({ body: { success: true, data: { success: true } } });
    await expect(checkIdentity(t.d1, "a", "x", { twitterToken: "tok", fetch: f.impl })).resolves.toEqual({
      status: "busy",
    });
    const g = stubFetch(xInfo("nothing"), { body: { success: true, data: null } });
    await expect(checkIdentity(t.d1, "a", "x", { twitterToken: "tok", fetch: g.impl })).resolves.toEqual({
      status: "busy",
    });
    expect(row().verified_at).toBeNull();
  });

  it("treats a profile of another account as busy", async () => {
    const f = stubFetch(xInfo(CODE, "impostor"));
    await expect(checkIdentity(t.d1, "a", "x", { twitterToken: "tok", fetch: f.impl })).resolves.toEqual({
      status: "busy",
    });
  });

  it("treats timeouts and server errors as busy", async () => {
    const f = stubFetch(new Error("timeout"));
    await expect(checkIdentity(t.d1, "a", "x", { twitterToken: "tok", fetch: f.impl })).resolves.toEqual({
      status: "busy",
    });
    const g = stubFetch({ status: 502 });
    await expect(checkIdentity(t.d1, "a", "x", { twitterToken: "tok", fetch: g.impl })).resolves.toEqual({
      status: "busy",
    });
  });

  it("is unavailable without a token and does not call 6551 or spend an attempt", async () => {
    const f = stubFetch();
    await expect(checkIdentity(t.d1, "a", "x", { fetch: f.impl })).resolves.toEqual({ status: "unavailable" });
    expect(f.calls).toHaveLength(0);
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM auth_attempts").get()).toEqual({ n: 0 });
  });

  it("is unavailable when 6551 rejects the token", async () => {
    const f = stubFetch({ status: 401 });
    await expect(checkIdentity(t.d1, "a", "x", { twitterToken: "bad", fetch: f.impl })).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("limits checks per person", async () => {
    const replies = Array.from({ length: CHECK_LIMITS.maxAttempts * 2 }, () => xInfo("nothing"));
    const f = stubFetch(...replies.flatMap((r) => [r, xPosts("gm")]));
    for (let i = 0; i < CHECK_LIMITS.maxAttempts; i++) {
      expect((await checkIdentity(t.d1, "a", "x", { twitterToken: "tok", fetch: f.impl })).status).toBe(
        "code_missing",
      );
    }
    const blocked = await checkIdentity(t.d1, "a", "x", { twitterToken: "tok", fetch: f.impl });
    expect(blocked).toMatchObject({ status: "rate_limited" });
    expect(f.calls).toHaveLength(CHECK_LIMITS.maxAttempts * 2);
  });

  it("does nothing more once verified", async () => {
    await checkIdentity(t.d1, "a", "x", { twitterToken: "tok", fetch: stubFetch(xInfo(CODE)).impl });
    const f = stubFetch();
    await expect(checkIdentity(t.d1, "a", "x", { twitterToken: "tok", fetch: f.impl })).resolves.toEqual({
      status: "already_verified",
    });
    expect(f.calls).toHaveLength(0);
  });
});

describe("checkIdentity for GitHub", () => {
  beforeEach(async () => {
    await setSingleIdentity(t.d1, "a", "github", "ada", CODE);
  });

  it("verifies by the code in the GitHub bio, without a token", async () => {
    const f = stubFetch({ body: { login: "Ada", bio: `builder ${CODE}` } });
    await expect(checkIdentity(t.d1, "a", "github", { fetch: f.impl })).resolves.toEqual({
      status: "verified",
      via: "bio_code",
    });
    expect(f.calls[0].url).toBe("https://api.github.com/users/ada");
    expect(f.calls[0].init?.headers).not.toHaveProperty("Authorization");
    expect(row()).toMatchObject({ verified_via: "bio_code", verify_code: null });
  });

  it("sends the token when there is one", async () => {
    const f = stubFetch({ body: { login: "ada", bio: CODE } });
    await checkIdentity(t.d1, "a", "github", { githubToken: "gh", fetch: f.impl });
    expect(f.calls[0].init?.headers).toMatchObject({ Authorization: "Bearer gh" });
  });

  it("says the code is missing, or that the login does not exist", async () => {
    await expect(
      checkIdentity(t.d1, "a", "github", { fetch: stubFetch({ body: { login: "ada", bio: null } }).impl }),
    ).resolves.toEqual({ status: "code_missing" });
    await expect(checkIdentity(t.d1, "a", "github", { fetch: stubFetch({ status: 404 }).impl })).resolves.toEqual({
      status: "not_found",
    });
  });

  it("treats other GitHub errors as busy", async () => {
    await expect(checkIdentity(t.d1, "a", "github", { fetch: stubFetch({ status: 403 }).impl })).resolves.toEqual({
      status: "busy",
    });
  });

  it("tells a spent GitHub rate limit apart", async () => {
    const limited = stubFetch({ status: 403, headers: { "x-ratelimit-remaining": "0" } });
    await expect(checkIdentity(t.d1, "a", "github", { fetch: limited.impl })).resolves.toEqual({
      status: "source_limited",
    });
    await expect(checkIdentity(t.d1, "a", "github", { fetch: stubFetch({ status: 429 }).impl })).resolves.toEqual({
      status: "source_limited",
    });
  });
});

it("has nothing to check without a linked handle", async () => {
  t = migratedD1();
  t.raw.exec("INSERT INTO users (id, email) VALUES ('a', 'a@example.com')");
  await expect(checkIdentity(t.d1, "a", "x", { twitterToken: "tok", fetch: stubFetch().impl })).resolves.toEqual({
    status: "no_identity",
  });
});
