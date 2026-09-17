import { describe, expect, it } from "vitest";
import { DISPLAY_NAME_MAX, DisplayNameError, nameFitsOneLine, nameFontScale, normalizeDisplayName, suggestDisplayName } from "./display-name";

describe("normalizeDisplayName", () => {
  it.each([
    ["alice", "alice"],
    ["  Alice   Smith ", "Alice Smith"],
    ["@alice_eth", "@alice_eth"],
    ["J. Doe", "J. Doe"],
    ["J.R.R. Tolkien", "J.R.R. Tolkien"],
    ["Zoë O'Brien-Łukasz", "Zoë O'Brien-Łukasz"],
    ["Олександр Ґудзь", "Олександр Ґудзь"],
    ["Ze\u0301", "Z\u00e9"], // NFC: e + наголос стає однією літерою
  ])("accepts %j", (raw, expected) => {
    expect(normalizeDisplayName(raw)).toBe(expected);
  });

  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["alice ".repeat(6), "longer"],
    ["alice 🚀", "letters"],
    ["alice<script>", "letters"],
    ["https://alice.dev", "link"],
    ["alice/dev", "letters"],
    ["0x52908400098527886E0F7030069857D2E4169EE7", "wallet"],
    ["0x5290ab", "wallet"],
    ["7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV", "wallet"],
    ["vitalik.eth", "wallet"],
    ["toly.sol", "wallet"],
    ["alice.xyz", "link"],
    ["www.alice", "link"],
  ])("rejects %j", (raw, reason) => {
    expect(() => normalizeDisplayName(raw)).toThrow(DisplayNameError);
    expect(() => normalizeDisplayName(raw)).toThrow(new RegExp(reason));
  });
});

describe("suggestDisplayName", () => {
  it("prefers the verified X handle", () => {
    expect(suggestDisplayName("zerocool", "someone@example.com")).toBe("@zerocool");
  });

  it("falls back to the first part of the email, without dots or tags", () => {
    expect(suggestDisplayName(null, "ada.lovelace+jobs@example.com")).toBe("ada lovelace");
    expect(suggestDisplayName(null, "owner@example.com")).toBe("owner");
  });

  it("leaves the field empty when the email part is not an allowed name", () => {
    expect(suggestDisplayName(null, "0x52908400098527886e0f@example.com")).toBe("");
    expect(suggestDisplayName(null, null)).toBe("");
  });
});

// K2, раунд 5: довгий нік на картці («@KESTREL.DELACROIX») зменшує кегль, а не обрізає «…».
describe("nameFontScale", () => {
  it("keeps full size for names that already fit on one line", () => {
    expect(nameFontScale("alice")).toBe(1);
    expect(nameFontScale("@ada_ships")).toBe(1);
  });

  it("shrinks a name that would wrap, in proportion to its length", () => {
    // «@KESTREL.DEV» (12 символів) переносився на два рядки: тепер кегель трохи менший.
    expect(nameFontScale("@KESTREL.DEV")).toBeLessThan(1);
    expect(nameFontScale("@KESTREL.DEV")).toBeGreaterThan(0.85);
    // Довге ім'я не мілішає нескінченно: нижче межі читабельності його краще перенести.
    expect(nameFontScale("A".repeat(DISPLAY_NAME_MAX))).toBeGreaterThanOrEqual(0.62);
    expect(nameFitsOneLine("@KESTREL.DEV")).toBe(true);
    expect(nameFitsOneLine("A".repeat(DISPLAY_NAME_MAX))).toBe(false);
  });

  it("shrinks as the name gets longer, and stops at a readable floor", () => {
    const short = nameFontScale("@kestrel.dev");
    const long = nameFontScale("@kestrel.delacroix1234");
    expect(long).toBeLessThan(short);
    expect(short).toBeLessThanOrEqual(1);
    // Нижче межі читабельності кегель не падає, замість цього ім'я переноситься (nameFitsOneLine).
    expect(nameFontScale("A".repeat(DISPLAY_NAME_MAX))).toBe(nameFontScale("A".repeat(DISPLAY_NAME_MAX * 2)));
    expect(nameFitsOneLine("A".repeat(DISPLAY_NAME_MAX))).toBe(false);
  });

  it("never returns a scale that would need truncation logic to hide overflow", () => {
    for (let n = 1; n <= DISPLAY_NAME_MAX; n++) {
      const scale = nameFontScale("a".repeat(n));
      expect(scale).toBeGreaterThanOrEqual(0.55);
      expect(scale).toBeLessThanOrEqual(1);
    }
  });
});
