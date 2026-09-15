"use server";

import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { setTestimonialStatus, TESTIMONIAL_STATUS, type TestimonialStatus } from "@/lib/testimonials";

const PAGE = "/admin/testimonials";

function back(query: string): never {
  redirect(`${PAGE}?${query}`);
}

function isStatus(v: unknown): v is TestimonialStatus {
  return typeof v === "string" && (TESTIMONIAL_STATUS as readonly string[]).includes(v);
}

/** «Approve» / «Hide» / «Back to pending» у /admin/testimonials. */
export async function setTestimonialStatusAction(form: FormData): Promise<void> {
  const admin = await currentAdmin();
  if (!admin) back("error=not_admin");
  const id = String(form.get("id") ?? "");
  const status = form.get("status");
  if (!isStatus(status)) back("error=invalid_status");
  const res = await setTestimonialStatus(db(), id, status);
  if (!res.ok) back("error=not_found");
  back(`done=${status}`);
}
