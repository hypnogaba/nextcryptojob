import { describe, expect, it } from "vitest";
import { nameFitsOneLine } from "./display-name";
import { OG_SIZE, renderCardImage, SealCard, SHARE_SIZES, ShareImage } from "./og";
import { FINISHES } from "./tiers";
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

// og.tsx будує дерево через JSX, не через реальний рендер React. Компоненти тут чисті
// (без хуків), тож можна викликати їх як функції й обійти дерево напряму, не піднімаючи
// jsdom чи react-dom: функціональний компонент у дереві розгортаємо викликом, решту читаємо.
type Node = null | undefined | boolean | string | number | { type: unknown; props: Record<string, unknown> };

function resolve(node: Node): Node {
  if (node && typeof node === "object" && typeof node.type === "function") {
    return resolve((node.type as (props: Record<string, unknown>) => Node)(node.props));
  }
  return node;
}

function childrenOf(node: Node): Node[] {
  const n = resolve(node);
  if (!n || typeof n !== "object") return [];
  const kids = n.props.children;
  if (kids === undefined || kids === null) return [];
  return Array.isArray(kids) ? (kids as Node[]) : [kids as Node];
}

function collectText(node: Node, out: string[] = []): string[] {
  const n = resolve(node);
  if (typeof n === "string") out.push(n);
  else if (typeof n === "number") out.push(String(n));
  else for (const child of childrenOf(n)) collectText(child, out);
  return out;
}

type Tagged = { type: unknown; props: Record<string, unknown> };

function collectTags(node: Node, tag: string, out: Tagged[] = []): Tagged[] {
  const n = resolve(node);
  if (n && typeof n === "object" && n.type === tag) out.push(n);
  for (const child of childrenOf(n)) collectTags(child, tag, out);
  return out;
}

describe("renderCardImage", () => {
  it.each([
    ["link", OG_SIZE],
    ["wide", { width: 1200, height: 675 }],
    ["tall", { width: 1080, height: 1350 }],
    ["square", { width: 1200, height: 1200 }],
  ] as const)("renders the %s image at its size, with fonts, sheet and seal", async (format, size) => {
    expect(SHARE_SIZES[format]).toEqual(size);
    const res = renderCardImage(cardView(CARD, EVIDENCE), format);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    const bytes = await png(res);
    expect(pngSize(bytes)).toEqual(size);
    // Порожнє полотно стискається до кількох КБ; з текстом, печаткою й диском більше.
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

describe("square seal layout (напрям D)", () => {
  it("shows the score, role, level, handle and card number", () => {
    const view = cardView(CARD, EVIDENCE);
    const texts = collectText(ShareImage({ view, format: "square" }));
    expect(texts).toContain(String(view.score));
    expect(texts).toContain(view.roleName);
    // Рівень і обробка стоять у рядку сезону, у крузі лише бал і роль (власник 16.09).
    expect(texts.some((t) => t.includes(`Level ${view.level} of 10`))).toBe(true);
    expect(texts).not.toContain("of 100");
    expect(texts).toContain(view.displayName);
    expect(texts).toContain(view.number);
  });

  it("stacks the disc above the seal ring so the lines never cross the digits", () => {
    const view = cardView(CARD, EVIDENCE);
    const root = SealCard({ view, size: 1200 });
    const [seal] = collectTags(root, "img");
    const disc = collectTags(root, "div").find(
      (n) => (n.props.style as Record<string, unknown>)?.backgroundColor === view.tier.window,
    );
    expect(seal).toBeTruthy();
    expect(disc).toBeTruthy();
    const sealZ = Number((seal!.props.style as Record<string, unknown>).zIndex);
    const discZ = Number((disc!.props.style as Record<string, unknown>).zIndex);
    expect(Number.isFinite(sealZ)).toBe(true);
    expect(discZ).toBeGreaterThan(sealZ);
  });

  it("keeps a handle that fits one line unwrapped (regression: @KESTREL.DEV used to wrap)", () => {
    const view = cardView({ ...CARD, displayName: "@KESTREL.DEV" });
    expect(nameFitsOneLine(view.displayName)).toBe(true);
    const root = SealCard({ view, size: 1200 });
    const nameSpan = collectTags(root, "span").find((n) => n.props.children === view.displayName);
    expect(nameSpan).toBeTruthy();
    expect((nameSpan!.props.style as Record<string, unknown>).whiteSpace).toBe("nowrap");
  });

  it.each(FINISHES)("renders the $name finish at square size", async ({ sample }) => {
    const view = cardView({ ...CARD, level: sample, score: Math.min(100, sample * 10) });
    const bytes = await png(renderCardImage(view, "square"));
    expect(pngSize(bytes)).toEqual(SHARE_SIZES.square);
  }, 30_000);
});
