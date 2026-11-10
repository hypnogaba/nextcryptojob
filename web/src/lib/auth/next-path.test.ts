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
    expect(safeNextPath(`/${"a".repeat(2100)}`)).toBeNull();
  });

  it("keeps a connector authorize request, which is longer than 512 characters", () => {
    const q = new URLSearchParams({
      response_type: "code",
      client_id: "https://claude.ai/oauth/mcp-oauth-client-metadata",
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      state: "s".repeat(300),
      code_challenge: "c".repeat(43),
      code_challenge_method: "S256",
      resource: "https://nextcryptojob.xyz/mcp/me",
      scope: "jobs offline_access",
    });
    const next = `/oauth/authorize?${q}`;
    expect(next.length).toBeGreaterThan(512);
    expect(safeNextPath(next)).toBe(next);
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
