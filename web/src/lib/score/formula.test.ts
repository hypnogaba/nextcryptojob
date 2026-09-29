import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EXAMPLE_BREAKDOWN } from "@/lib/card/example";
import { FORMULA_VERSION } from "./formula";

describe("formula version shown to people", () => {
  it("is the version the engine actually scores with", () => {
    const engine = readFileSync(new URL("../../../../engine/src/formula/v7.ts", import.meta.url), "utf8");
    expect(/export const FORMULA_VERSION = "(v\d+)"/.exec(engine)?.[1]).toBe(FORMULA_VERSION);
  });

  it("reaches the /scoring page and the example card from that one constant", async () => {
    const { default: ScoringPage } = await import("@/app/scoring/page");
    const html = renderToStaticMarkup(ScoringPage());
    expect(html).toContain(`Formula ${FORMULA_VERSION}`);
    expect(html).not.toContain("Formula v7");
    expect(EXAMPLE_BREAKDOWN.formula).toBe(FORMULA_VERSION);
  });
});
