import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** /openapi.yaml на сайті (посилання зі сторінки Developers) це той самий договір, що docs/api/openapi.yaml. */
describe("public OpenAPI copy", () => {
  it("matches docs/api/openapi.yaml byte for byte (run node scripts/api-docs.mjs)", () => {
    const source = readFileSync(new URL("../../../../docs/api/openapi.yaml", import.meta.url), "utf8");
    const copy = readFileSync(new URL("../../../public/openapi.yaml", import.meta.url), "utf8");
    expect(copy).toBe(source);
  });
});
