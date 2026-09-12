import { describe, expect, it } from "vitest";
import { OG_SIZE, renderCardImage } from "./og";
import type { PublicCard } from "./store";
import { cardView } from "./view";

const CARD: PublicCard = {
  slug: "aB3_-x9QzK",
  role: "product_manager", // найдовша назва ролі
  score: 100,
  level: 10,
  displayName: "Олександр Ґудзь-Łukasz O'Brien",
  formulaVersion: "v5",
  createdAt: "2026-09-12 08:30:00",
};

/** Ширина й висота з заголовка IHDR PNG. */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe("renderCardImage", () => {
  it("renders a 1200x630 PNG for a card, with fonts and pattern", async () => {
    const res = renderCardImage(cardView(CARD));
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(pngSize(bytes)).toEqual(OG_SIZE);
    // Порожнє полотно стискається до кількох КБ; з текстом і візерунком більше.
    expect(bytes.length).toBeGreaterThan(20_000);

    if (process.env.CARD_PNG_OUT) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(process.env.CARD_PNG_OUT, bytes);
    }
  }, 30_000);
});
