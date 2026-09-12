import { describe, expect, it } from "vitest";
import { containsCode, isVerifyCode, newVerifyCode } from "./code";

describe("newVerifyCode", () => {
  it("makes ncj- and 6 base32 characters", () => {
    for (let i = 0; i < 200; i++) expect(newVerifyCode()).toMatch(/^ncj-[a-z2-7]{6}$/);
  });

  it("does not repeat", () => {
    const codes = new Set(Array.from({ length: 1000 }, newVerifyCode));
    expect(codes.size).toBe(1000);
  });
});

describe("isVerifyCode", () => {
  it.each([
    ["ncj-abc234", true],
    ["ncj-ABC234", false],
    ["ncj-abc238", false],
    ["ncj-abc23", false],
    ["", false],
    [null, false],
  ])("%j → %j", (value, expected) => {
    expect(isVerifyCode(value)).toBe(expected);
  });
});

describe("containsCode", () => {
  const code = "ncj-k7qx2a";

  it.each([
    "ncj-k7qx2a",
    "small frog ncj-k7qx2a working on stuff",
    "NCJ-K7QX2A in capitals",
    "(ncj-k7qx2a)",
    "code:ncj-k7qx2a.",
    "ｎｃｊ－ｋ７ｑｘ２ａ", // широкі літери, які X лишає як є
  ])("finds the code in %j", (text) => {
    expect(containsCode(text, code)).toBe(true);
  });

  it.each(["", "ncj-k7qx2", "ncj-k7qx2ab", "xncj-k7qx2a", "ncj k7qx2a", "someone else's ncj-aaaaaa"])(
    "does not find it in %j",
    (text) => {
      expect(containsCode(text, code)).toBe(false);
    },
  );

  it("never matches with a malformed code", () => {
    expect(containsCode("anything .* here", ".*")).toBe(false);
  });
});
