import { describe, expect, it } from "vitest";
import { layerPath, makeSeal, petalAngle, petalPath, sealSeed, sealSvg, SEAL_BOX } from "./seal";

const WALLET = "0x7a3f00000000000000000000000000000000c91e";

/** Усі числа шляху парами (x, y). */
function points(d: string): [number, number][] {
  const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
  return out;
}

describe("sealSeed", () => {
  it("gives the same seed for the same wallet, whatever the EVM letter case", () => {
    expect(sealSeed({ wallet: WALLET })).toBe(sealSeed({ wallet: WALLET }));
    expect(sealSeed({ wallet: WALLET.toUpperCase().replace("0X", "0x") })).toBe(sealSeed({ wallet: WALLET }));
  });

  it("keeps Solana addresses as they are: case matters in base58", () => {
    const sol = "BGjMfx5BqV7x1YkdQ8m1uQ2x3oJ9sH4c5Qm7Pk2Wn8Ld";
    expect(sealSeed({ wallet: sol })).not.toBe(sealSeed({ wallet: sol.toLowerCase() }));
  });

  it("prefers the verified wallet and falls back to the card slug", () => {
    expect(sealSeed({ wallet: WALLET, slug: "aB3_-x9QzK" })).toBe(sealSeed({ wallet: WALLET }));
    expect(sealSeed({ wallet: null, slug: "aB3_-x9QzK" })).toBe(sealSeed({ slug: "aB3_-x9QzK" }));
    expect(sealSeed({ slug: "aB3_-x9QzK" })).not.toBe(sealSeed({ wallet: "aB3_-x9QzK" }));
  });

  it("refuses to invent a seal without a wallet or a slug", () => {
    expect(() => sealSeed({})).toThrow();
  });
});

describe("makeSeal", () => {
  const seed = sealSeed({ wallet: WALLET });

  it("draws the same seal for the same wallet", () => {
    expect(makeSeal(seed, 8)).toEqual(makeSeal(sealSeed({ wallet: WALLET }), 8));
    expect(makeSeal(seed, 8).map((l) => layerPath(l))).toEqual(makeSeal(seed, 8).map((l) => layerPath(l)));
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])("has as many layers as the level (%s)", (level) => {
    expect(makeSeal(seed, level)).toHaveLength(level);
  });

  it("clamps the level into 1..10", () => {
    expect(makeSeal(seed, 0)).toHaveLength(1);
    expect(makeSeal(seed, 14)).toHaveLength(10);
  });

  it("adds a layer on level up and keeps the layers already drawn", () => {
    for (let level = 1; level < 10; level++) {
      expect(makeSeal(seed, level + 1).slice(0, level)).toEqual(makeSeal(seed, level));
    }
  });

  it("draws different seals for different wallets", () => {
    const wallets = Array.from({ length: 300 }, (_, i) => `0x${i.toString(16).padStart(40, "0")}`);
    const seals = new Set(wallets.map((w) => JSON.stringify(makeSeal(sealSeed({ wallet: w }), 3))));
    expect(seals.size).toBe(wallets.length);
  });

  it("nests the layers inside each other and inside the box", () => {
    const layers = makeSeal(seed, 10);
    for (let i = 1; i < layers.length; i++) {
      expect(layers[i].a + layers[i].b).toBeLessThan(layers[i - 1].a + layers[i - 1].b);
    }
    for (const l of layers) {
      for (const [x, y] of points(layerPath(l))) expect(Math.hypot(x, y)).toBeLessThan(SEAL_BOX);
    }
  });

  it("uses fewer petals on share images, so the rosette does not turn into a grey blob", () => {
    const page = makeSeal(seed, 10, "page");
    const share = makeSeal(seed, 10, "share");
    share.forEach((l, i) => {
      expect(l.petals).toBeLessThan(page[i].petals);
      expect(l.a).toBe(page[i].a);
    });
  });
});

describe("paths", () => {
  const [layer] = makeSeal(sealSeed({ slug: "aB3_-x9QzK" }), 1);

  it("repeats one petal around the centre: its end is its start turned by 360/m degrees", () => {
    const pts = points(petalPath(layer));
    const [x0, y0] = pts[0];
    const [x1, y1] = pts.at(-1)!;
    const turn = (petalAngle(layer, 1) * Math.PI) / 180;
    expect(x1).toBeCloseTo(x0 * Math.cos(turn) - y0 * Math.sin(turn), 0);
    expect(y1).toBeCloseTo(x0 * Math.sin(turn) + y0 * Math.cos(turn), 0);
  });

  it("closes the full layer where it started", () => {
    const d = layerPath(layer);
    expect(d.endsWith("Z")).toBe(true);
    const pts = points(d);
    expect(pts.at(-1)![0]).toBeCloseTo(pts[0][0], 0);
    expect(pts.at(-1)![1]).toBeCloseTo(pts[0][1], 0);
  });

  it("writes one stroked path per layer for the image renderer", () => {
    const svg = sealSvg(makeSeal(1234, 4), { inks: ["#111111", "#222222"], strokeWidth: 1.5, size: 300 });
    expect(svg.match(/<path /g)).toHaveLength(4);
    expect(svg.match(/stroke="#111111"/g)).toHaveLength(2);
    expect(svg).not.toContain("<use");
  });
});
