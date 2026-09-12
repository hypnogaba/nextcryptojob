import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomToken, sha256Hex } from "@/lib/auth/hash";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { hasAccess } from "@/lib/billing/access";
import type { AppEnv } from "@/lib/db";
import { addCompany, addUser, crmDb } from "@/test/crm-fixtures";
import { exec, harness, RedirectCalled, resetHarness, rows } from "@/test/harness";
import { grantAccessAction, revokeAccessAction } from "./actions";
import AdminCompaniesPage from "./page";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/navigation", async () => ({
  ...(await import("@/test/harness")).navigationModule,
  notFound: (): never => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

let company: string;

function setup(env: Record<string, string> = {}) {
  resetHarness(env as Partial<AppEnv>);
  const { raw, d1 } = crmDb();
  harness.raw = raw;
  harness.env.DB = d1;
  company = addCompany(raw, { name: "Acme Labs" });
}

async function signIn(email: string): Promise<string> {
  const id = addUser(harness.raw, { email });
  const token = randomToken();
  exec("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))", await sha256Hex(token), id);
  harness.jar.set(SESSION_COOKIE, token);
  return id;
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

async function redirectOf(p: Promise<void>): Promise<string> {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(RedirectCalled);
  return (err as RedirectCalled).url;
}

function inDays(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
}

beforeEach(() => setup());

describe("admin guard", () => {
  it("the owner email is admin by default; others and visitors are not", async () => {
    await signIn("someone@acme.io");
    expect(
      await redirectOf(grantAccessAction(form({ company_id: company, status: "active", period_end: inDays(30), note: "x" }))),
    ).toBe("/admin/companies?error=not_admin");
    expect(rows("SELECT * FROM subscriptions")).toEqual([]);
    await expect(AdminCompaniesPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_NOT_FOUND");

    setup();
    await expect(AdminCompaniesPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("ADMIN_EMAILS replaces the default list", async () => {
    setup({ ADMIN_EMAILS: " Ops@NextCryptoJob.xyz , other@example.com" });
    await signIn("hypnogaba@gmail.com");
    await expect(AdminCompaniesPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_NOT_FOUND");

    setup({ ADMIN_EMAILS: " Ops@NextCryptoJob.xyz , other@example.com" });
    await signIn("ops@nextcryptojob.xyz");
    const html = renderToStaticMarkup(await AdminCompaniesPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("Acme Labs");
  });
});

describe("grant and revoke", () => {
  let admin: string;
  beforeEach(async () => {
    admin = await signIn("hypnogaba@gmail.com");
  });

  it("lists companies with their access and card payment state", async () => {
    const html = renderToStaticMarkup(await AdminCompaniesPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("Acme Labs");
    expect(html).toContain("pay_per_request");
    expect(html).toContain("Card payments: off (not configured: STRIPE_SECRET_KEY, STRIPE_PRICE_ID, STRIPE_WEBHOOK_SECRET)");
    expect(html).toContain("Grant access");
    expect(html).not.toContain(">Revoke<");
  });

  it("grants access until the end of the chosen day and then revokes it", async () => {
    const end = inDays(20);
    const url = await redirectOf(
      grantAccessAction(form({ company_id: company, status: "trialing", period_end: end, note: "Hackathon jury" })),
    );
    expect(url).toBe(`/admin/companies?done=granted&company=${company}`);
    expect(rows("SELECT provider, status, current_period_end, granted_by, note FROM subscriptions")).toEqual([
      { provider: "manual", status: "trialing", current_period_end: `${end} 23:59:59`, granted_by: admin, note: "Hackathon jury" },
    ]);
    expect(await hasAccess(harness.env.DB, company)).toBe(true);

    const html = renderToStaticMarkup(
      await AdminCompaniesPage({ searchParams: Promise.resolve({ done: "granted", company }) }),
    );
    expect(html).toContain("Access granted to Acme Labs.");
    expect(html).toContain(">Revoke<");

    expect(await redirectOf(revokeAccessAction(form({ company_id: company })))).toBe(
      `/admin/companies?done=revoked&company=${company}`,
    );
    expect(await hasAccess(harness.env.DB, company)).toBe(false);
  });

  it("sends bad input back with a reason and writes nothing", async () => {
    const bad = async (fields: Record<string, string>) =>
      redirectOf(grantAccessAction(form({ company_id: company, status: "active", period_end: inDays(10), note: "ok", ...fields })));
    expect(await bad({ status: "past_due" })).toBe(`/admin/companies?error=invalid_status&company=${company}`);
    expect(await bad({ period_end: "2026-02-30" })).toBe(`/admin/companies?error=invalid_period&company=${company}`);
    expect(await bad({ period_end: inDays(-2) })).toBe(`/admin/companies?error=invalid_period&company=${company}`);
    expect(await bad({ note: "" })).toBe(`/admin/companies?error=note_required&company=${company}`);
    expect(await bad({ company_id: "co_AAAAAAAAAAAAAAAAAAAA" })).toBe(
      "/admin/companies?error=not_found&company=co_AAAAAAAAAAAAAAAAAAAA",
    );
    expect(await bad({ company_id: "../../etc" })).toBe("/admin/companies?error=not_found");
    expect(rows("SELECT * FROM subscriptions")).toEqual([]);
  });
});
