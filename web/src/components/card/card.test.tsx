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
  it("shows the score in the seal, with role, level, name, number and finish around it", () => {
    const html = renderToStaticMarkup(<CardFront face={exampleFace()} />);
    for (const text of [">73<", "of 100", "Engineer", "Level 8 of 10", "@kestrel.dev", "No. kSt7rEl0dv", "Season 1 · Chrome"]) {
      expect(html).toContain(text);
    }
    // Напрям D: печатка на весь аркуш, бал у чистому крузі поверх неї.
    expect(html).toContain("ncj-medal-seal");
    expect(html).toContain("ncj-medal-core");
    // Джерела бала («GH 74 X 46 ONC 92») на лицьовому боці немає (лише на звороті), як і банківського підпису.
    for (const gone of [">GH<", ">ONC<", "ncj-stats", "ncj-face-badge", "ncj-mid-seal"]) expect(html).not.toContain(gone);
  });

  it("prints a long name in full, never cut to an ellipsis (K2)", () => {
    const longName = "@kestrel.delacroix1234";
    const html = renderToStaticMarkup(<CardFront face={{ ...exampleFace(), displayName: longName }} />);
    expect(html).toContain(`<b>${longName}</b>`);
    expect(html).not.toContain("…");
  });

  it("draws the seal only once the card is issued, and keeps the level either way", () => {
    const html = renderToStaticMarkup(<CardFront face={{ ...exampleFace(), sealSeed: null, kind: "draft" }} />);
    expect(html).not.toContain("ncj-seal");
    expect(html).toContain("ncj-medal-seal-empty");
    expect(html).toContain("Level 8 of 10");
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
  it("spins on every card by default, and stands still where a page asks for it (lists of many cards)", () => {
    const seal = (spin?: boolean) => renderToStaticMarkup(<Seal seed={42} level={8} inks={["#000000", "#555555"]} spin={spin} />);
    expect(seal(true)).toContain('class="ncj-seal ncj-seal-spin"');
    expect(seal()).not.toContain("ncj-seal-spin");
    // Власник 16.09: «щоб рухалися всі елементи, так крутилися». Картка крутиться скрізь,
    // окрім місць, де їх багато на сторінці (лідерборд просить spin={false}).
    expect(renderToStaticMarkup(<CardFront face={exampleFace()} draw />)).toContain("ncj-seal-spin");
    expect(renderToStaticMarkup(<CardFront face={exampleFace()} spin={false} />)).not.toContain("ncj-seal-spin");
  });
});

describe("CardBackFace", () => {
  it("itemizes the formula and prints none with the reason", () => {
    const html = renderToStaticMarkup(<CardBackFace face={exampleFace()} back={EXAMPLE_BACK} meta="Formula v5." />);
    for (const text of [">Weight<", ">82.0<", ">32.8<", ">+25<", ">+5<", ">Work<", ">Reputation and breadth<", ">48.8<", ">100%<"]) {
      expect(html).toContain(text);
    }
  });
});
