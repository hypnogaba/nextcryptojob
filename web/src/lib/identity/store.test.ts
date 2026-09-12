import { beforeEach, describe, expect, it } from "vitest";
import { migratedD1, type TestDb } from "@/test/sqlite-d1";
import { listIdentities, markVerified, removeIdentities, setSingleIdentity, setWallets } from "./store";

let t: TestDb;
const EVM = "0xe6b532e63f228087e26a5897131f2e1d043e27f2";
const SOL = "BGjMfx5Bc9647ydxh2WJ1ow5pWZEjanMugTe5snXKY1z";

function identities(userId: string) {
  return t.raw
    .prepare("SELECT kind, value, verify_code, verified_via FROM identities WHERE user_id = ? ORDER BY id")
    .all(userId)
    .map((r) => ({ ...r }));
}

function ageRow(kind: string, value: string, sql = "-2 days") {
  t.raw.prepare("UPDATE identities SET created_at = datetime('now', ?) WHERE kind = ? AND value = ?").run(sql, kind, value);
}

beforeEach(() => {
  t = migratedD1();
  t.raw.exec("INSERT INTO users (id, email) VALUES ('a', 'a@example.com'), ('b', 'b@example.com')");
});

describe("setSingleIdentity", () => {
  it("links a handle with its code", async () => {
    await expect(setSingleIdentity(t.d1, "a", "x", "ada", "ncj-aaaaaa")).resolves.toEqual({ ok: true });
    expect(identities("a")).toEqual([{ kind: "x", value: "ada", verify_code: "ncj-aaaaaa", verified_via: null }]);
  });

  it("replaces the person's previous handle of the same kind", async () => {
    await setSingleIdentity(t.d1, "a", "github", "old");
    await setSingleIdentity(t.d1, "a", "github", "new");
    expect(identities("a").map((r) => r.value)).toEqual(["new"]);
  });

  it("keeps the code when the same handle is saved again", async () => {
    await setSingleIdentity(t.d1, "a", "x", "ada", "ncj-first1");
    await setSingleIdentity(t.d1, "a", "x", "ada", "ncj-second");
    expect(identities("a")[0].verify_code).toBe("ncj-first1");
  });

  it("refuses a handle verified by another profile", async () => {
    await setSingleIdentity(t.d1, "b", "x", "ada", "ncj-bbbbbb");
    await markVerified(t.d1, "b", "x", "ada", "bio_code");
    ageRow("x", "ada");
    await expect(setSingleIdentity(t.d1, "a", "x", "ada", "ncj-aaaaaa")).resolves.toEqual({ ok: false, reason: "taken" });
    expect(identities("a")).toEqual([]);
  });

  it("waits a day before releasing another profile's unverified X claim", async () => {
    await setSingleIdentity(t.d1, "b", "x", "ada", "ncj-bbbbbb");
    await expect(setSingleIdentity(t.d1, "a", "x", "ada", "ncj-aaaaaa")).resolves.toEqual({
      ok: false,
      reason: "pending",
    });
    ageRow("x", "ada");
    await expect(setSingleIdentity(t.d1, "a", "x", "ada", "ncj-aaaaaa")).resolves.toEqual({ ok: true });
    expect(identities("b")).toEqual([]);
    expect(identities("a")[0]).toMatchObject({ value: "ada", verify_code: "ncj-aaaaaa" });
  });

  it("never releases sources that cannot be verified here", async () => {
    await setSingleIdentity(t.d1, "b", "site", "https://example.org");
    ageRow("site", "https://example.org", "-30 days");
    await expect(setSingleIdentity(t.d1, "a", "site", "https://example.org")).resolves.toEqual({
      ok: false,
      reason: "taken",
    });
  });

  it("keeps the old value when the new one is taken", async () => {
    await setSingleIdentity(t.d1, "a", "github", "mine");
    await setSingleIdentity(t.d1, "b", "github", "theirs");
    await setSingleIdentity(t.d1, "a", "github", "theirs");
    expect(identities("a").map((r) => r.value)).toEqual(["mine"]);
  });

  it("removes a kind", async () => {
    await setSingleIdentity(t.d1, "a", "youtube", "@ada");
    await removeIdentities(t.d1, "a", "youtube");
    expect(identities("a")).toEqual([]);
  });
});

describe("markVerified", () => {
  it("marks only the person's own unverified row and clears the code", async () => {
    await setSingleIdentity(t.d1, "a", "x", "ada", "ncj-aaaaaa");
    await expect(markVerified(t.d1, "b", "x", "ada", "bio_code")).resolves.toBe(false);
    await expect(markVerified(t.d1, "a", "x", "ada", "post_code")).resolves.toBe(true);
    expect(identities("a")[0]).toMatchObject({ verified_via: "post_code", verify_code: null });
    await expect(markVerified(t.d1, "a", "x", "ada", "bio_code")).resolves.toBe(false);
  });
});

describe("setWallets", () => {
  it("adds, keeps and removes addresses to match the new list", async () => {
    await setWallets(t.d1, "a", [{ kind: "evm", value: EVM }]);
    const res = await setWallets(t.d1, "a", [{ kind: "solana", value: SOL }]);
    expect(res).toEqual({ ok: true, added: 1, removed: 1 });
    expect((await listIdentities(t.d1, "a")).map((i) => i.value)).toEqual([SOL]);
  });

  it("names each address that belongs to another profile and saves nothing", async () => {
    await setWallets(t.d1, "b", [{ kind: "evm", value: EVM }]);
    const res = await setWallets(t.d1, "a", [
      { kind: "evm", value: EVM },
      { kind: "solana", value: SOL },
    ]);
    expect(res).toEqual({ ok: false, taken: [{ kind: "evm", value: EVM }] });
    expect(identities("a")).toEqual([]);
  });

  it("clears all wallets with an empty list", async () => {
    await setWallets(t.d1, "a", [{ kind: "evm", value: EVM }]);
    await setWallets(t.d1, "a", []);
    expect(identities("a")).toEqual([]);
  });

  it("does not touch other kinds", async () => {
    await setSingleIdentity(t.d1, "a", "github", "ada");
    await setWallets(t.d1, "a", []);
    expect(identities("a").map((r) => r.kind)).toEqual(["github"]);
  });
});
