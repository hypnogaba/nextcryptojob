import { resolveRobots } from "next/dist/build/webpack/loaders/metadata/resolve-route-data";
import { describe, expect, it } from "vitest";
import robots from "./robots";

/** robots.txt, як його віддає Next: сайт відкритий, закрито лише перенаправлення "Apply". */
describe("robots.txt", () => {
  it("disallows only /jobs/*/apply and allows the rest, with no sitemap line while there is no sitemap", () => {
    const text = resolveRobots(robots());
    expect(text).toBe("User-Agent: *\nAllow: /\nDisallow: /jobs/*/apply\n\n");
  });
});
