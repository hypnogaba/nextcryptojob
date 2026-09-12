import { beforeEach, describe, expect, it, vi } from "vitest";
import { markVerified, removeIdentities, setSingleIdentity } from "@/lib/identity/store";
import { migratedD1, type TestDb } from "@/test/sqlite-d1";
import { checkClaim, claimCode, holderOf } from "./claim";

const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
let t: TestDb;

function fetchReturning(...bodies: unknown[]) {
  const calls: string[] = [];
  const impl = vi.fn(async (url: string | URL | Request) => {
    calls.push(String(url));
    const body = bodies.shift();
    if (body === undefined) throw new Error("unexpected fetch");
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}
const xBio = (description: string) => ({ data: { screenName: "ada", description } });
const ghBio = (bio: string) => ({ login: "ada", bio });
const rows = () =>
  t.raw
    .prepare("SELECT user_id, kind, value, verified_via FROM identities ORDER BY id")
    .all()
    .map((r) => ({ ...r }));

beforeEach(() => {
  t = migratedD1();
  // squatter вводить чужий нік, owner справжній власник.
  t.raw.exec("INSERT INTO users (id, email) VALUES ('squatter', 's@example.com'), ('owner', 'o@example.com')");
});

describe("claimCode", () => {
  it("is an ncj- code, stable per person, source and handle", async () => {
    const a = await claimCode(SECRET, "x", "ada", "owner");
    expect(a).toMatch(/^ncj-[a-z2-7]{6}$/);
    await expect(claimCode(SECRET, "x", "ada", "owner")).resolves.toBe(a);
    await expect(claimCode(SECRET, "x", "ada", "squatter")).resolves.not.toBe(a);
    await expect(claimCode(SECRET, "github", "ada", "owner")).resolves.not.toBe(a);
    await expect(claimCode("other-secret", "x", "ada", "owner")).resolves.not.toBe(a);
  });
});

describe("checkClaim", () => {
  it("hands an unverified X claim to the owner who shows the claim code", async () => {
    await setSingleIdentity(t.d1, "squatter", "x", "ada", "ncj-aaaaaa");
    await setSingleIdentity(t.d1, "owner", "x", "old", "ncj-bbbbbb");
    await expect(holderOf(t.d1, "owner", "x", "ada")).resolves.toBe("pending");
    const code = await claimCode(SECRET, "x", "ada", "owner");
    const f = fetchReturning(xBio(`frog ${code}`));
    await expect(
      checkClaim(t.d1, "owner", "x", "ada", { secret: SECRET, twitterToken: "tok", fetch: f.impl }),
    ).resolves.toEqual({ status: "verified", via: "bio_code" });
    expect(rows()).toEqual([{ user_id: "owner", kind: "x", value: "ada", verified_via: "bio_code" }]);
  });

  it("does not care that the squatter removed and re-added the handle to reset the clock", async () => {
    await setSingleIdentity(t.d1, "squatter", "x", "ada", "ncj-aaaaaa");
    t.raw.exec("UPDATE identities SET created_at = datetime('now', '-3 days')");
    await removeIdentities(t.d1, "squatter", "x");
    await setSingleIdentity(t.d1, "squatter", "x", "ada", "ncj-cccccc");
    // Свіжий рядок, але власник усе одно забирає нік кодом.
    await expect(setSingleIdentity(t.d1, "owner", "x", "ada", "ncj-dddddd")).resolves.toEqual({
      ok: false,
      reason: "pending",
    });
    const code = await claimCode(SECRET, "x", "ada", "owner");
    const f = fetchReturning(xBio("nothing"), { data: [{ id: "1", conversationId: "1", text: code, userScreenName: "ada" }] });
    await expect(
      checkClaim(t.d1, "owner", "x", "ada", { secret: SECRET, twitterToken: "tok", fetch: f.impl }),
    ).resolves.toEqual({ status: "verified", via: "post_code" });
    expect(rows()).toEqual([{ user_id: "owner", kind: "x", value: "ada", verified_via: "post_code" }]);
  });

  it("does not accept the squatter's own code or a retweet of the claim code", async () => {
    await setSingleIdentity(t.d1, "squatter", "x", "ada", "ncj-aaaaaa");
    const code = await claimCode(SECRET, "x", "ada", "owner");
    const f = fetchReturning(xBio("ncj-aaaaaa"), {
      data: [{ id: "1", conversationId: "1", text: `RT @owner: ${code}`, userScreenName: "ada" }],
    });
    await expect(
      checkClaim(t.d1, "owner", "x", "ada", { secret: SECRET, twitterToken: "tok", fetch: f.impl }),
    ).resolves.toEqual({ status: "code_missing" });
    expect(rows()).toEqual([{ user_id: "squatter", kind: "x", value: "ada", verified_via: null }]);
  });

  it("refuses when the handle is verified by another profile, without reading it", async () => {
    await setSingleIdentity(t.d1, "squatter", "github", "ada", "ncj-aaaaaa");
    await markVerified(t.d1, "squatter", "github", "ada", "bio_code");
    const f = fetchReturning();
    await expect(checkClaim(t.d1, "owner", "github", "ada", { secret: SECRET, fetch: f.impl })).resolves.toEqual({
      status: "taken",
    });
    expect(f.calls).toEqual([]);
  });

  it("rolls back if the other profile verifies between the check and the write", async () => {
    await setSingleIdentity(t.d1, "squatter", "github", "ada", "ncj-aaaaaa");
    await setSingleIdentity(t.d1, "owner", "github", "mine", "ncj-bbbbbb");
    const code = await claimCode(SECRET, "github", "ada", "owner");
    const impl = vi.fn(async () => {
      // Поки ми читаємо GitHub, той профіль підтверджує нік.
      await markVerified(t.d1, "squatter", "github", "ada", "bio_code");
      return new Response(JSON.stringify(ghBio(code)), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(checkClaim(t.d1, "owner", "github", "ada", { secret: SECRET, fetch: impl })).resolves.toEqual({
      status: "taken",
    });
    expect(rows()).toEqual([
      { user_id: "squatter", kind: "github", value: "ada", verified_via: "bio_code" },
      { user_id: "owner", kind: "github", value: "mine", verified_via: null },
    ]);
  });

  it("works for GitHub and for a handle nobody holds any more", async () => {
    const code = await claimCode(SECRET, "github", "ada", "owner");
    const f = fetchReturning(ghBio(`hi ${code}`));
    await expect(checkClaim(t.d1, "owner", "github", "ada", { secret: SECRET, fetch: f.impl })).resolves.toEqual({
      status: "verified",
      via: "bio_code",
    });
    expect(rows()).toEqual([{ user_id: "owner", kind: "github", value: "ada", verified_via: "bio_code" }]);
  });

  it("shares the per-person check limit", async () => {
    await setSingleIdentity(t.d1, "squatter", "x", "ada", "ncj-aaaaaa");
    const replies = Array.from({ length: 10 }, () => [xBio("no"), { data: [{ id: "1", text: "gm" }] }]).flat();
    const f = fetchReturning(...replies);
    for (let i = 0; i < 10; i++) {
      await checkClaim(t.d1, "owner", "x", "ada", { secret: SECRET, twitterToken: "tok", fetch: f.impl });
    }
    await expect(
      checkClaim(t.d1, "owner", "x", "ada", { secret: SECRET, twitterToken: "tok", fetch: f.impl }),
    ).resolves.toMatchObject({ status: "rate_limited" });
  });
});
