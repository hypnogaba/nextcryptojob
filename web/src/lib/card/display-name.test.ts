import { describe, expect, it } from "vitest";
import { DISPLAY_NAME_MAX, DisplayNameError, nameFontScale, normalizeDisplayName, suggestDisplayName } from "./display-name";

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
    expect(suggestDisplayName("hypnogaba", "someone@example.com")).toBe("@hypnogaba");
  });

  it("falls back to the first part of the email, without dots or tags", () => {
    expect(suggestDisplayName(null, "ada.lovelace+jobs@example.com")).toBe("ada lovelace");
    expect(suggestDisplayName(null, "hypnogaba@gmail.com")).toBe("hypnogaba");
  });

  it("leaves the field empty when the email part is not an allowed name", () => {
    expect(suggestDisplayName(null, "0x52908400098527886e0f@example.com")).toBe("");
    expect(suggestDisplayName(null, null)).toBe("");
  });
});

// K2, раунд 5: довгий нік на картці («@KESTREL.DELACROIX») зменшує кегль, а не обрізає «…».
describe("nameFontScale", () => {
  it("keeps full size for short names", () => {
    expect(nameFontScale("alice")).toBe(1);
    expect(nameFontScale("@ada_ships")).toBe(1);
  });

  it("shrinks steadily as the name gets longer, never below the floor", () => {
    const short = nameFontScale("@kestrel.dev");
    const long = nameFontScale("@kestrel.delacroix1234");
    const max = nameFontScale("A".repeat(DISPLAY_NAME_MAX));
    expect(long).toBeLessThan(short);
    expect(max).toBeLessThan(long);
    expect(max).toBeGreaterThanOrEqual(0.55);
    expect(short).toBeLessThanOrEqual(1);
  });

  it("never returns a scale that would need truncation logic to hide overflow", () => {
    for (let n = 1; n <= DISPLAY_NAME_MAX; n++) {
      const scale = nameFontScale("a".repeat(n));
      expect(scale).toBeGreaterThanOrEqual(0.55);
      expect(scale).toBeLessThanOrEqual(1);
    }
  });
});
