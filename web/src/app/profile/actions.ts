"use server";

import { redirect } from "next/navigation";
import type { FormMessage } from "@/components/form/form-message";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth/session";
import { issueCard } from "@/lib/card/issue";
import { db } from "@/lib/db";
import { enqueueScoreJob } from "@/lib/score/queue";

export type ProfileActionState = { message?: FormMessage; name?: string };

/** «Try again» і «Update my score»: нове завдання в черзі (правило 60 с стежить черга). */
export async function rescoreAction(_prev: ProfileActionState): Promise<ProfileActionState> {
  const user = await requireUser();
  const res = await enqueueScoreJob(db(), user.id, "manual");
  if (res.ok) redirect("/profile");
  switch (res.reason) {
    case "already_queued":
      return { message: { tone: "info", text: "Your score is already in the queue." } };
    case "too_soon":
      return { message: { tone: "error", text: `Try again in ${res.retryAfterSeconds} seconds.` } };
    case "no_consent":
      return { message: { tone: "error", text: "Give your consent first, in the last setup step." } };
  }
}

/** «Create my card»: знімок балу ролі з іменем, яке людина підтвердила. */
export async function createCardAction(_prev: ProfileActionState, form: FormData): Promise<ProfileActionState> {
  const user = await requireUser();
  const role = String(form.get("role") ?? "");
  const name = String(form.get("name") ?? "");
  let res;
  try {
    // Те саме правило, що вимикає кнопку на сторінці: дію можна викликати й напряму.
    res = await issueCard(db(), user.id, { role, displayName: name });
  } catch (err) {
    console.error("createCard failed:", err instanceof Error ? err.message : String(err));
    return { message: { tone: "error", text: "Something went wrong. Try again." }, name };
  }
  if (!res.ok) return { message: { tone: "error", text: res.message }, name };
  const slug = res.slug;
  await audit(user.id, "card.create", slug, { role });
  redirect(`/c/${slug}`);
}
