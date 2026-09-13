import { describe, expect, it } from "vitest";
import { fnv1a, mulberry32 } from "./pattern";

describe("fnv1a", () => {
  it("matches the reference FNV-1a 32-bit values", () => {
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("a")).toBe(0xe40c292c);
    expect(fnv1a("foobar")).toBe(0xbf9cf968);
  });
});

describe("mulberry32", () => {
  it("gives the same numbers for the same seed, in [0, 1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(Array.from({ length: 1000 }, () => b())).toEqual(xs);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
  });

  it("gives different numbers for different seeds", () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});
