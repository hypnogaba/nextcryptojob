import { describe, expect, it } from "vitest";
import { OG_SIZE, renderCardImage, SHARE_SIZES } from "./og";
import type { PublicCard } from "./store";
import { cardView, type CardEvidence } from "./view";

const CARD: PublicCard = {
  slug: "aB3_-x9QzK",
  role: "product_manager", // найдовша назва ролі
  score: 100,
  level: 10,
  displayName: "Олександр Ґудзь-Łukasz O'Brien",
  formulaVersion: "v5",
  createdAt: "2026-09-12 08:30:00",
};

const EVIDENCE: CardEvidence = {
  score: 100,
  formulaVersion: "v5",
  breakdownJson: JSON.stringify({
    core: { x: { weight: 50, value: 100 }, gh_builder: { weight: 25, value: 100 }, site: { weight: 25, value: null } },
    bonus: { onchain: { max: 5, value: 90 }, gh_eng: { max: 5, value: null } },
    cover: 75,
  }),
  wallet: null,
  connected: ["x", "github"],
};

/** Ширина й висота з заголовка IHDR PNG. */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

async function png(res: Response): Promise<Uint8Array> {
  expect(res.headers.get("content-type")).toBe("image/png");
  const bytes = new Uint8Array(await res.arrayBuffer());
  expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

describe("renderCardImage", () => {
  it.each([
    ["link", OG_SIZE],
    ["wide", { width: 1200, height: 675 }],
    ["tall", { width: 1080, height: 1350 }],
  ] as const)("renders the %s image at its size, with fonts, card and seal", async (format, size) => {
    expect(SHARE_SIZES[format]).toEqual(size);
    const res = renderCardImage(cardView(CARD, EVIDENCE), format);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    const bytes = await png(res);
    expect(pngSize(bytes)).toEqual(size);
    // Порожнє полотно стискається до кількох КБ; з текстом, карткою й печаткою більше.
    expect(bytes.length).toBeGreaterThan(40_000);
    const out = process.env[`CARD_PNG_OUT_${format.toUpperCase()}`];
    if (out) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(out, bytes);
    }
  }, 30_000);

  it("renders a trader card with no breakdown", async () => {
    const bytes = await png(renderCardImage(cardView({ ...CARD, role: "trader", score: 82, level: 9 }), "wide"));
    expect(pngSize(bytes)).toEqual(SHARE_SIZES.wide);
    if (process.env.CARD_PNG_OUT_TRADER) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(process.env.CARD_PNG_OUT_TRADER, bytes);
    }
  }, 30_000);
});
