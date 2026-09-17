import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ADMIN_GROUPS, ADMIN_MAIN, ADMIN_MORE, ADMIN_PAGES, ADMIN_TAIL, AdminNav } from "./admin-nav";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);

describe("admin menu", () => {
  it("keeps every admin page, each once, in the row or in a group", () => {
    const all = [...ADMIN_MAIN, ...ADMIN_MORE, ...ADMIN_TAIL];
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual(ADMIN_PAGES.map((p) => p.href).sort());
    expect(ADMIN_MAIN.length + ADMIN_TAIL.length).toBeLessThanOrEqual(6);
  });

  it("puts everything about companies, applications and payments in one group", () => {
    const companies = ADMIN_GROUPS.find((g) => g.label === "Companies");
    expect(companies?.pages).toEqual(["/admin/companies", "/admin/agency-applications", "/admin/jobs", "/admin/payments"]);
  });

  it("names the current page on the group button when it lives there", () => {
    const html = renderToStaticMarkup(<AdminNav current="/admin/payments" viewAsCompanyId={null} />);
    expect(html).toContain("Companies: Payments");
    expect(html).toMatch(/aria-current="page"[^>]*>Payments</);
  });

  it("shows plain group names on a main page", () => {
    const html = renderToStaticMarkup(<AdminNav current="/admin/candidates" viewAsCompanyId={null} />);
    expect(html).toMatch(/>More<span/);
    expect(html).toMatch(/>Companies<span/);
    expect(html).toMatch(/aria-current="page"[^>]*>Candidates</);
  });
});
