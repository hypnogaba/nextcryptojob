"use server";

import type { FormMessage } from "@/components/form/form-message";
import { currentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { submitTestimonial } from "@/lib/testimonials";

export type FeedbackState = { message?: FormMessage };

/**
 * «Got a job through NextCryptoJob? Tell us» (/feedback, B). Працює й для гостя (user_id
 * null): userId бере лише currentUser() на сервері, не з форми, щоб чужий акаунт не
 * можна було підписати підказкою в HTML.
 */
export async function submitFeedbackAction(_prev: FeedbackState, form: FormData): Promise<FeedbackState> {
  const user = await currentUser();
  const res = await submitTestimonial(db(), {
    userId: user?.id ?? null,
    displayName: form.get("display_name"),
    company: form.get("company"),
    role: form.get("role"),
    text: form.get("text"),
    display: form.get("display"),
    consentPublic: form.get("consent_public"),
  });
  if (!res.ok) {
    const text = res.reason === "text_too_short" ? "Tell us a bit more." : res.reason === "text_too_long" ? "Keep it shorter." : "Choose how to show your name.";
    return { message: { tone: "error", text } };
  }
  return { message: { tone: "success", text: "Thank you. We may feature this on the site once we review it." } };
}
