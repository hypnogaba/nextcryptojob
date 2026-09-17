import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ADMIN_MAIN, ADMIN_MORE, ADMIN_PAGES, AdminNav } from "./admin-nav";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);

describe("admin menu", () => {
  it("keeps every admin page, each once, in the row or under More", () => {
    const all = [...ADMIN_MAIN, ...ADMIN_MORE];
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual(ADMIN_PAGES.map((p) => p.href).sort());
    expect(ADMIN_MAIN.length).toBeLessThanOrEqual(6);
  });

  it("names the current page on the More button when it lives there", () => {
    const html = renderToStaticMarkup(<AdminNav current="/admin/payments" viewAsCompanyId={null} />);
    expect(html).toContain("More: Payments");
    expect(html).toMatch(/aria-current="page"[^>]*>Payments</);
  });

  it("shows plain More on a main page", () => {
    const html = renderToStaticMarkup(<AdminNav current="/admin/scores" viewAsCompanyId={null} />);
    expect(html).toMatch(/>More<span/);
    expect(html).toMatch(/aria-current="page"[^>]*>Scores</);
  });
});
