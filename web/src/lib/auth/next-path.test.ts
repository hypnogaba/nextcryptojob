import { describe, expect, it } from "vitest";
import { loginPathFor, safeNextPath } from "./next-path";

describe("safeNextPath", () => {
  it("keeps a same-site path with its query", () => {
    expect(safeNextPath("/company/join?t=abc123")).toBe("/company/join?t=abc123");
    expect(safeNextPath("/jobs")).toBe("/jobs");
  });

  it("refuses anything that could leave the site", () => {
    for (const bad of [
      "https://evil.example/x",
      "//evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "javascript:alert(1)",
      "evil.example",
      "/ok\r\nSet-Cookie: a=b",
      "/tab\there",
      "",
      "   ",
      null,
      undefined,
      42,
    ]) {
      expect(safeNextPath(bad)).toBeNull();
    }
  });

  it("refuses an absurdly long value", () => {
    expect(safeNextPath(`/${"a".repeat(600)}`)).toBeNull();
  });
});

describe("loginPathFor", () => {
  it("carries the return path, encoded", () => {
    expect(loginPathFor("/company/join?t=a&b=c")).toBe("/login?next=%2Fcompany%2Fjoin%3Ft%3Da%26b%3Dc");
  });

  it("falls back to plain /login for an unsafe path", () => {
    expect(loginPathFor("https://evil.example")).toBe("/login");
  });
});
