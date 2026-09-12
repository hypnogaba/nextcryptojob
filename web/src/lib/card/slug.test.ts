import { describe, expect, it } from "vitest";
import { isSlug, newSlug } from "./slug";

describe("newSlug", () => {
  it("is 10 URL-safe characters", () => {
    for (let i = 0; i < 200; i++) {
      const slug = newSlug();
      expect(slug).toMatch(/^[A-Za-z0-9_-]{10}$/);
      expect(encodeURIComponent(slug)).toBe(slug);
    }
  });

  it("does not repeat", () => {
    const slugs = new Set(Array.from({ length: 5000 }, newSlug));
    expect(slugs.size).toBe(5000);
  });

  it("uses the whole alphabet", () => {
    const seen = new Set(Array.from({ length: 2000 }, newSlug).join(""));
    expect(seen.size).toBe(64);
  });
});

describe("isSlug", () => {
  it("accepts only the slug shape", () => {
    expect(isSlug("aB3_-x9QzK")).toBe(true);
    expect(isSlug("short")).toBe(false);
    expect(isSlug("aB3_-x9QzK1")).toBe(false);
    expect(isSlug("aB3_-x9Qz/")).toBe(false);
    expect(isSlug("../../etc/")).toBe(false);
  });
});
