import { beforeEach, describe, expect, it } from "vitest";
import { sqliteD1 } from "@/test/sqlite-d1";
import {
  addLink,
  DEFAULT_PREFS,
  ensureKeyVersion,
  keyMatches,
  loadPrefs,
  normalizeLink,
  profileKey,
  removeLink,
  resetKey,
  setHidden,
  setShowWallet,
} from "./profile-prefs";

let db: D1Database;

beforeEach(() => {
  const { db: d, raw } = sqliteD1(["0001_core", "0026_profile_prefs"]);
  db = d;
  raw.exec("INSERT INTO users (id, email) VALUES ('u1', 'a@example.com'), ('u2', 'b@example.com')");
});

describe("prefs", () => {
  it("gives defaults without a row", async () => {
    expect(await loadPrefs(db, "u1")).toEqual(DEFAULT_PREFS);
  });

  it("hides and shows items without touching other settings", async () => {
    await setShowWallet(db, "u1", true);
    expect(await setHidden(db, "u1", "github.stars", true)).toBe(true);
    await setHidden(db, "u1", "words.role", true);
    await setHidden(db, "u1", "github.stars", false);
    expect(await loadPrefs(db, "u1")).toMatchObject({ hidden: ["words.role"], showWallet: true });
    expect(await loadPrefs(db, "u2")).toEqual(DEFAULT_PREFS);
  });

  it("refuses a malformed item id", async () => {
    expect(await setHidden(db, "u1", "x'); DROP TABLE users;--", true)).toBe(false);
    expect((await loadPrefs(db, "u1")).hidden).toEqual([]);
  });

  it("adds up to ten links and removes by index", async () => {
    for (let i = 0; i < 10; i++) expect((await addLink(db, "u1", `L${i}`, `https://ex.org/${i}`)).ok).toBe(true);
    expect(await addLink(db, "u1", "L10", "https://ex.org/10")).toEqual({ ok: false, error: "You can add up to 10 links." });
    await removeLink(db, "u1", 0);
    await removeLink(db, "u1", 99);
    expect((await loadPrefs(db, "u1")).links.map((l) => l.label)).toEqual(["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9"]);
  });
});

describe("normalizeLink", () => {
  it("keeps https, query and anchor", () => {
    expect(normalizeLink(" Demo  talk ", "https://YouTube.com/watch?v=abc#t=1")).toEqual({
      ok: true,
      link: { label: "Demo talk", url: "https://youtube.com/watch?v=abc#t=1" },
    });
  });

  it.each([
    ["http://ex.org"],
    ["javascript:alert(1)"],
    ["https://localhost/x"],
    ["https://127.0.0.1/"],
    ["https://user:pw@ex.org/"],
    [`https://ex.org/${"a".repeat(300)}`],
  ])("refuses %s", (url) => {
    expect(normalizeLink("x", url).ok).toBe(false);
  });

  it("needs a label under 40 characters", () => {
    expect(normalizeLink("  ", "https://ex.org").ok).toBe(false);
    expect(normalizeLink("a".repeat(41), "https://ex.org").ok).toBe(false);
  });
});

describe("apply key", () => {
  it("is stable for a version and changes after reset", async () => {
    expect(await ensureKeyVersion(db, "u1")).toBe(1);
    expect(await ensureKeyVersion(db, "u1")).toBe(1);
    const k1 = await profileKey("secret", "u1", 1);
    expect(k1).toMatch(/^[0-9a-f]{32}$/);
    expect(await profileKey("secret", "u1", 1)).toBe(k1);
    expect(await resetKey(db, "u1")).toBe(2);
    const k2 = await profileKey("secret", "u1", 2);
    expect(keyMatches(k2, k1)).toBe(false);
    expect(keyMatches(k2, k2)).toBe(true);
  });

  it("reset before any key starts at version 2", async () => {
    expect(await resetKey(db, "u2")).toBe(2);
  });

  it("does not open another person's card or a different secret", async () => {
    const mine = await profileKey("secret", "u1", 1);
    expect(keyMatches(await profileKey("secret", "u2", 1), mine)).toBe(false);
    expect(keyMatches(await profileKey("other", "u1", 1), mine)).toBe(false);
  });

  it("rejects missing or odd keys", () => {
    expect(keyMatches(null, "a".repeat(32))).toBe(false);
    expect(keyMatches("a".repeat(32), undefined)).toBe(false);
    expect(keyMatches("a".repeat(32), "a")).toBe(false);
  });
});
