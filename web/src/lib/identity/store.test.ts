import { beforeEach, describe, expect, it } from "vitest";
import { migratedD1, type TestDb } from "@/test/sqlite-d1";
import { listIdentities, removeIdentities, setSingleIdentity, setWallets } from "./store";

let t: TestDb;
const EVM = "0xe6b532e63f228087e26a5897131f2e1d043e27f2";
const SOL = "BGjMfx5Bc9647ydxh2WJ1ow5pWZEjanMugTe5snXKY1z";

function identities(userId: string) {
  return t.raw
    .prepare("SELECT kind, value, verify_code, verified_via FROM identities WHERE user_id = ? ORDER BY id")
    .all(userId)
    .map((r) => ({ ...r }));
}

beforeEach(() => {
  t = migratedD1();
  t.raw.exec("INSERT INTO users (id, email) VALUES ('a', 'a@example.com'), ('b', 'b@example.com')");
});

describe("setSingleIdentity", () => {
  it("links a handle without any code", async () => {
    await setSingleIdentity(t.d1, "a", "x", "ada");
    expect(identities("a")).toEqual([{ kind: "x", value: "ada", verify_code: null, verified_via: null }]);
  });

  it("replaces the person's previous handle of the same kind", async () => {
    await setSingleIdentity(t.d1, "a", "github", "old");
    await setSingleIdentity(t.d1, "a", "github", "new");
    expect(identities("a").map((r) => r.value)).toEqual(["new"]);
  });

  it("saving the same handle again keeps the row as it is (an old verification mark stays)", async () => {
    await setSingleIdentity(t.d1, "a", "x", "ada");
    t.raw.exec("UPDATE identities SET verified_via = 'bio_code', verified_at = datetime('now') WHERE user_id = 'a'");
    await setSingleIdentity(t.d1, "a", "x", "ada");
    expect(identities("a")).toEqual([{ kind: "x", value: "ada", verify_code: null, verified_via: "bio_code" }]);
  });

  it("the same handle can be on two profiles: no squatting, no code (owner 14.09, round 3)", async () => {
    await setSingleIdentity(t.d1, "b", "x", "ada");
    t.raw.exec("UPDATE identities SET verified_via = 'bio_code', verified_at = datetime('now') WHERE user_id = 'b'");
    await setSingleIdentity(t.d1, "a", "x", "ada");
    await setSingleIdentity(t.d1, "a", "github", "ada");
    await setSingleIdentity(t.d1, "b", "github", "ada");
    await setSingleIdentity(t.d1, "a", "site", "https://example.org");
    await setSingleIdentity(t.d1, "b", "site", "https://example.org");
    expect(identities("a").map((r) => `${r.kind}:${r.value}`)).toEqual(["x:ada", "github:ada", "site:https://example.org"]);
    expect(identities("b").map((r) => `${r.kind}:${r.value}`)).toEqual(["x:ada", "github:ada", "site:https://example.org"]);
  });

  it("one profile still holds a value once", () => {
    t.raw.exec("INSERT INTO identities (user_id, kind, value) VALUES ('a', 'x', 'ada')");
    expect(() => t.raw.exec("INSERT INTO identities (user_id, kind, value) VALUES ('a', 'x', 'ada')")).toThrow(/UNIQUE/);
  });

  it("removes a kind", async () => {
    await setSingleIdentity(t.d1, "a", "youtube", "@ada");
    await removeIdentities(t.d1, "a", "youtube");
    expect(identities("a")).toEqual([]);
  });
});

describe("setWallets", () => {
  it("adds, keeps and removes addresses to match the new list", async () => {
    await setWallets(t.d1, "a", [{ kind: "evm", value: EVM }]);
    const res = await setWallets(t.d1, "a", [{ kind: "solana", value: SOL }]);
    expect(res).toEqual({ added: 1, removed: 1 });
    expect((await listIdentities(t.d1, "a")).map((i) => i.value)).toEqual([SOL]);
  });

  it("an address another profile added too is saved all the same", async () => {
    await setWallets(t.d1, "b", [{ kind: "evm", value: EVM }]);
    const res = await setWallets(t.d1, "a", [
      { kind: "evm", value: EVM },
      { kind: "solana", value: SOL },
    ]);
    expect(res).toEqual({ added: 2, removed: 0 });
    expect(identities("a").map((r) => r.value)).toEqual([EVM, SOL]);
    expect(identities("b").map((r) => r.value)).toEqual([EVM]);
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
