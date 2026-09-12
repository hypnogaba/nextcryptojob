import { describe, expect, it } from "vitest";
import { DisplayNameError, normalizeDisplayName } from "./display-name";

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
