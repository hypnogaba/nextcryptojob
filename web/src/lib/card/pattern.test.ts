import { describe, expect, it } from "vitest";
import {
  fnv1a,
  makePattern,
  patternDataUri,
  patternSeed,
  patternSvg,
  PATTERN_HEIGHT,
  PATTERN_WIDTH,
} from "./pattern";

describe("fnv1a", () => {
  it("matches the reference FNV-1a 32-bit values", () => {
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("a")).toBe(0xe40c292c);
    expect(fnv1a("foobar")).toBe(0xbf9cf968);
  });
});

describe("makePattern", () => {
  it("gives the same pattern for the same seed", () => {
    const seed = patternSeed("alice", "security_auditor");
    expect(makePattern(seed)).toEqual(makePattern(seed));
  });

  it("gives different patterns to different people with the same role", () => {
    const seeds = Array.from({ length: 200 }, (_, i) => patternSeed(`person${i}`, "engineer"));
    const unique = new Set(seeds.map((s) => JSON.stringify(makePattern(s))));
    expect(unique.size).toBe(seeds.length);
  });

  it("gives the same person a different pattern per role", () => {
    expect(makePattern(patternSeed("alice", "engineer"))).not.toEqual(
      makePattern(patternSeed("alice", "trader")),
    );
  });

  it("keeps shapes on the canvas side away from the text plate", () => {
    for (let i = 0; i < 500; i++) {
      const p = makePattern(`seed-${i}`);
      expect(p.stripes.cx - p.stripes.r).toBeGreaterThan(500);
      expect(p.stripes.cx).toBeLessThanOrEqual(PATTERN_WIDTH);
      expect(p.stripes.width).toBeLessThan(p.stripes.gap);
      expect(p.rings.length).toBeGreaterThanOrEqual(1);
      expect(p.arcs.length).toBeGreaterThanOrEqual(2);
      for (const a of p.arcs) {
        expect(a.sweep).toBeGreaterThanOrEqual(60);
        expect(a.sweep).toBeLessThanOrEqual(200);
        expect(a.cy).toBeGreaterThanOrEqual(0);
        expect(a.cy).toBeLessThanOrEqual(PATTERN_HEIGHT);
      }
    }
  });
});

describe("patternSvg", () => {
  const pattern = makePattern(patternSeed("alice", "engineer"));

  it("draws every shape in the given colour", () => {
    const svg = patternSvg(pattern, "#FFFFFF", 0.3);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 1200 630"/);
    const rings = pattern.rings.reduce((n, g) => n + g.count, 0);
    const lines = svg.match(/<line /g)?.length ?? 0;
    // Кожна фігура несе колір і прозорість сама (див. коментар у patternSvg).
    expect(svg.match(/stroke="#FFFFFF" stroke-opacity="0.3"/g)).toHaveLength(lines + rings + pattern.arcs.length);
    expect(svg.match(/<circle /g)).toHaveLength(rings + 1); // +1: коло обрізки смуг
    expect(svg.match(/<path /g)).toHaveLength(pattern.arcs.length);
    expect(svg.endsWith("</svg>")).toBe(true);
  });

  it("encodes as a data URI that decodes back to the same SVG", () => {
    const uri = patternDataUri(pattern, "#0E1213", 0.3);
    expect(uri.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(atob(uri.split(",")[1])).toBe(patternSvg(pattern, "#0E1213", 0.3));
  });
});
