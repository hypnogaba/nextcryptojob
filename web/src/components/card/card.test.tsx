import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SharePreview } from "@/components/landing/share-preview";
import { EXAMPLE_BACK, exampleFace } from "@/lib/card/example";
import { ShareImage } from "@/lib/card/og";
import { makeSeal } from "@/lib/card/seal";
import type { PublicCard } from "@/lib/card/store";
import { cardView } from "@/lib/card/view";
import { CardBackFace } from "./card-back";
import { CardFront } from "./card-front";
import { Seal } from "./seal";

const CARD: PublicCard = {
  slug: "aB3_-x9QzK",
  role: "engineer",
  score: 73.2,
  level: 8,
  displayName: "@ada_ships",
  formulaVersion: "v5",
  createdAt: "2026-09-12 08:30:00",
};

describe("EXAMPLE tag", () => {
  it("never renders on a real card, on the page or in the images for X", () => {
    for (let level = 1; level <= 10; level++) {
      const view = cardView({ ...CARD, level, score: (level - 1) * 10 + 3 });
      expect(view.kind).toBe("real");
      const html = [
        renderToStaticMarkup(<CardFront face={view} draw />),
        renderToStaticMarkup(<CardBackFace face={view} back={null} meta="" />),
        renderToStaticMarkup(<SharePreview face={view} reasons="" />),
        renderToStaticMarkup(<ShareImage view={view} format="wide" />),
        renderToStaticMarkup(<ShareImage view={view} format="tall" />),
      ].join("");
      expect(html).not.toMatch(/example|specimen/i);
    }
  });

  it("marks the landing example, and only there", () => {
    const html = renderToStaticMarkup(<CardFront face={exampleFace()} />);
    expect(html).toContain(">Example card<");
    expect(renderToStaticMarkup(<CardFront face={{ ...exampleFace(), kind: "draft" }} />)).not.toContain(">Example card<");
    // Прев'ю картинки для X показує картку без позначки: вона там лише як малюнок.
    expect(renderToStaticMarkup(<SharePreview face={exampleFace()} reasons="" />)).not.toContain(">Example card<");
  });
});

describe("CardFront", () => {
  it("shows score, role, name, level and finish in the footer, the card number, and no per-source stats", () => {
    const html = renderToStaticMarkup(<CardFront face={exampleFace()} />);
    for (const text of [
      ">73<",
      "of 100<b>Engineer</b>",
      "@kestrel.dev",
      ">Level<",
      "<b>8 of 10</b>",
      ">Finish<",
      "<b>Chrome</b>",
      "No. kSt7rEl0dv",
      "Season 1",
    ]) {
      expect(html).toContain(text);
    }
    expect(html).toContain("ncj-mid-seal");
    // Джерела бала («GH 74 X 46 ONC 92») на лицьовому боці більше немає (лише на звороті).
    for (const gone of [">GH<", ">ONC<", "ncj-stats", "ncj-face-badge"]) expect(html).not.toContain(gone);
  });

  it("prints a long name in full, never cut to an ellipsis (K2)", () => {
    const longName = "@kestrel.delacroix1234";
    const html = renderToStaticMarkup(<CardFront face={{ ...exampleFace(), displayName: longName }} />);
    expect(html).toContain(`<b>${longName}</b>`);
    expect(html).not.toContain("…");
  });

  it("draws the seal only once the card is issued, and keeps the level in the footer either way", () => {
    const html = renderToStaticMarkup(<CardFront face={{ ...exampleFace(), sealSeed: null, kind: "draft" }} />);
    expect(html).not.toContain("ncj-seal");
    expect(html).toContain("ncj-mid-seal-empty");
    expect(html).toContain("<b>8 of 10</b>");
  });
});

describe("Seal", () => {
  it.each([1, 4, 8, 10])("renders %s layers, one petal each repeated around the centre", (level) => {
    const html = renderToStaticMarkup(<Seal seed={42} level={level} inks={["#000000", "#555555"]} />);
    const layers = makeSeal(42, level);
    expect(html.match(/class="ncj-layer"/g)).toHaveLength(level);
    expect(html.match(/<use /g)).toHaveLength(layers.reduce((n, l) => n + l.petals, 0));
  });
});

describe("Seal motion", () => {
  it("spins only where asked: the landing's small card and the /scoring card, never a real card by default", () => {
    const seal = (spin?: boolean) => renderToStaticMarkup(<Seal seed={42} level={8} inks={["#000000", "#555555"]} spin={spin} />);
    expect(seal(true)).toContain('class="ncj-seal ncj-seal-spin"');
    expect(seal()).not.toContain("ncj-seal-spin");
    expect(renderToStaticMarkup(<CardFront face={exampleFace()} draw />)).not.toContain("ncj-seal-spin");
    expect(renderToStaticMarkup(<CardFront face={exampleFace()} draw spin />)).toContain("ncj-seal ncj-seal-draw ncj-seal-spin");
  });
});

describe("CardBackFace", () => {
  it("itemizes the formula and prints none with the reason", () => {
    const html = renderToStaticMarkup(<CardBackFace face={exampleFace()} back={EXAMPLE_BACK} meta="Formula v5." />);
    for (const text of [">Weight<", ">74.2<", ">59.4<", ">+5<", ">none<", "none: no website linked", ">68.6<", ">100%<"]) {
      expect(html).toContain(text);
    }
  });
});
