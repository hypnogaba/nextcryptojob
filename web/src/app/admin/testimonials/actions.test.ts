import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomToken, sha256Hex } from "@/lib/auth/hash";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { submitTestimonial } from "@/lib/testimonials";
import { addUser, crmDb } from "@/test/crm-fixtures";
import { exec, harness, RedirectCalled, resetHarness, rows } from "@/test/harness";
import { setTestimonialStatusAction } from "./actions";
import AdminTestimonialsPage from "./page";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/navigation", async () => ({
  ...(await import("@/test/harness")).navigationModule,
  notFound: (): never => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

/** /admin/testimonials (B): захист адміна, approve/hide/back-to-pending. */

function setup() {
  resetHarness();
  const { raw, d1 } = crmDb();
  harness.raw = raw;
  harness.env.DB = d1;
}

async function signIn(email: string, method: "email" | "telegram" = "email"): Promise<string> {
  const id = addUser(harness.raw, { email });
  const token = randomToken();
  exec("INSERT INTO sessions (id, user_id, expires_at, method) VALUES (?, ?, datetime('now', '+1 day'), ?)", await sha256Hex(token), id, method);
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

beforeEach(() => setup());

describe("admin guard", () => {
  it("a non-admin cannot approve, and cannot open the page", async () => {
    await signIn("someone@example.com");
    expect(await redirectOf(setTestimonialStatusAction(form({ id: "tst_x", status: "approved" })))).toBe(
      "/admin/testimonials?error=not_admin",
    );
    await expect(AdminTestimonialsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("approve / hide", () => {
  beforeEach(async () => {
    await signIn("hypnogaba@gmail.com");
  });

  it("approves a pending story, then hides it, then puts it back to pending", async () => {
    const res = await submitTestimonial(harness.env.DB, {
      userId: null,
      displayName: "Ada",
      company: null,
      role: null,
      text: "I found a role through my card and got hired.",
      display: "name",
      consentPublic: true,
    });
    if (!res.ok) throw new Error("expected ok");

    let html = renderToStaticMarkup(await AdminTestimonialsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("Ada");
    expect(html).toContain(">Approve<");

    expect(await redirectOf(setTestimonialStatusAction(form({ id: res.id, status: "approved" })))).toBe(
      "/admin/testimonials?done=approved",
    );
    expect(rows("SELECT status FROM testimonials WHERE id = ?", res.id)[0].status).toBe("approved");

    html = renderToStaticMarkup(await AdminTestimonialsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain(">Hide<");

    expect(await redirectOf(setTestimonialStatusAction(form({ id: res.id, status: "hidden" })))).toBe(
      "/admin/testimonials?done=hidden",
    );
    expect(rows("SELECT status FROM testimonials WHERE id = ?", res.id)[0].status).toBe("hidden");

    expect(await redirectOf(setTestimonialStatusAction(form({ id: res.id, status: "pending" })))).toBe(
      "/admin/testimonials?done=pending",
    );
    expect(rows("SELECT status FROM testimonials WHERE id = ?", res.id)[0].status).toBe("pending");
  });

  it("rejects an invalid status and an unknown id", async () => {
    expect(await redirectOf(setTestimonialStatusAction(form({ id: "tst_x", status: "public" })))).toBe(
      "/admin/testimonials?error=invalid_status",
    );
    expect(await redirectOf(setTestimonialStatusAction(form({ id: "tst_doesnotexist00000", status: "approved" })))).toBe(
      "/admin/testimonials?error=not_found",
    );
  });
});
