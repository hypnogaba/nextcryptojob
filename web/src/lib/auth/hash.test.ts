import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hmacSha256Hex, hmacSha256Verify, randomToken, sha256Hex } from "./hash";

describe("randomToken", () => {
  it("is 32 random bytes as base64url", () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  it("never repeats", () => {
    const seen = new Set(Array.from({ length: 1000 }, randomToken));
    expect(seen.size).toBe(1000);
  });
});

describe("hashes", () => {
  it("sha256Hex matches Node's SHA-256", async () => {
    await expect(sha256Hex("token")).resolves.toBe(createHash("sha256").update("token").digest("hex"));
  });

  it("hmacSha256Hex matches Node's HMAC-SHA256", async () => {
    const expected = createHmac("sha256", "secret").update("ada@example.com:123456").digest("hex");
    await expect(hmacSha256Hex("secret", "ada@example.com:123456")).resolves.toBe(expected);
  });

  it("hmacSha256Verify accepts the right message and rejects the rest", async () => {
    const mac = await hmacSha256Hex("secret", "ada@example.com:123456");
    await expect(hmacSha256Verify("secret", "ada@example.com:123456", mac)).resolves.toBe(true);
    await expect(hmacSha256Verify("secret", "ada@example.com:123457", mac)).resolves.toBe(false);
    await expect(hmacSha256Verify("other", "ada@example.com:123456", mac)).resolves.toBe(false);
    await expect(hmacSha256Verify("secret", "ada@example.com:123456", "zz")).resolves.toBe(false);
    await expect(hmacSha256Verify("secret", "ada@example.com:123456", mac.slice(2))).resolves.toBe(false);
  });
});
