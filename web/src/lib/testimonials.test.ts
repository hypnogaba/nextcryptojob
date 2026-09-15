import { describe, expect, it } from "vitest";
import { addUser, crmDb } from "@/test/crm-fixtures";
import { migratedD1 } from "@/test/sqlite-d1";
import { listApprovedTestimonials, listTestimonialsForAdmin, setTestimonialStatus, submitTestimonial } from "./testimonials";

/**
 * /feedback і /admin/testimonials (B): відгук пишеться зі статусом pending, публічний
 * список бере лише approved + consent_public, і код не падає без міграції 0023.
 */

const INPUT = {
  userId: null,
  displayName: "Ada",
  company: "Acme Labs",
  role: "Security auditor",
  text: "I found a role through my card and got hired in three weeks.",
  display: "name" as const,
  consentPublic: true,
};

describe("submitTestimonial", () => {
  it("writes a pending testimonial", async () => {
    const { d1 } = crmDb();
    const res = await submitTestimonial(d1, INPUT);
    expect(res.ok).toBe(true);
    const { rows } = await listTestimonialsForAdmin(d1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "pending", displayName: "Ada", consentPublic: true });
  });

  it("rejects text that is too short, too long, or an invalid display choice", async () => {
    const { d1 } = crmDb();
    expect(await submitTestimonial(d1, { ...INPUT, text: "short" })).toEqual({ ok: false, reason: "text_too_short" });
    expect(await submitTestimonial(d1, { ...INPUT, text: "x".repeat(2001) })).toEqual({ ok: false, reason: "text_too_long" });
    expect(await submitTestimonial(d1, { ...INPUT, display: "public" })).toEqual({ ok: false, reason: "invalid_display" });
  });

  it("works for a signed-in user, linking user_id", async () => {
    const { raw, d1 } = crmDb();
    const userId = addUser(raw, { email: "ada@example.com" });
    const res = await submitTestimonial(d1, { ...INPUT, userId });
    expect(res.ok).toBe(true);
    const { rows } = await listTestimonialsForAdmin(d1);
    expect(rows[0].userId).toBe(userId);
    expect(rows[0].userEmail).toBe("ada@example.com");
  });
});

describe("approve / hide flow", () => {
  it("only approved + consent_public shows publicly", async () => {
    const { d1 } = crmDb();
    const a = await submitTestimonial(d1, INPUT); // consent yes
    const b = await submitTestimonial(d1, { ...INPUT, displayName: "Bob", consentPublic: false }); // consent no
    if (!a.ok || !b.ok) throw new Error("unreachable");

    expect(await listApprovedTestimonials(d1)).toHaveLength(0);

    expect(await setTestimonialStatus(d1, a.id, "approved")).toEqual({ ok: true });
    expect(await setTestimonialStatus(d1, b.id, "approved")).toEqual({ ok: true });
    const publicList = await listApprovedTestimonials(d1);
    expect(publicList).toHaveLength(1);
    expect(publicList[0].name).toBe("Ada");

    expect(await setTestimonialStatus(d1, a.id, "hidden")).toEqual({ ok: true });
    expect(await listApprovedTestimonials(d1)).toHaveLength(0);
  });

  it("handle display falls back to null without a connected X identity", async () => {
    const { raw, d1 } = crmDb();
    const userId = addUser(raw, { email: "bob@example.com" });
    const res = await submitTestimonial(d1, { ...INPUT, userId, display: "handle" });
    if (!res.ok) throw new Error("unreachable");
    await setTestimonialStatus(d1, res.id, "approved");
    const list = await listApprovedTestimonials(d1);
    expect(list[0].name).toBeNull();
  });

  it("reports not_found for an unknown id", async () => {
    const { d1 } = crmDb();
    expect(await setTestimonialStatus(d1, "tst_doesnotexist00000", "approved")).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("without migration 0023", () => {
  it("listTestimonialsForAdmin and listApprovedTestimonials do not throw", async () => {
    const { d1 } = migratedD1();
    expect(await listTestimonialsForAdmin(d1)).toEqual({ rows: [], available: false, error: expect.stringContaining("0023") });
    expect(await listApprovedTestimonials(d1)).toEqual([]);
  });
});
