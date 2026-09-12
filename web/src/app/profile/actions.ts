"use server";

import { redirect } from "next/navigation";
import type { FormMessage } from "@/components/form/form-message";
import { audit } from "@/lib/audit";
import { consume } from "@/lib/auth/ratelimit";
import { requireUser } from "@/lib/auth/session";
import { isRoleKey } from "@/lib/card/roles";
import { CardInputError, createCard } from "@/lib/card/store";
import { db } from "@/lib/db";
import { parseRoles } from "@/lib/roles/catalog";
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

/** 20 карток на годину: кожна нова відкликає попередню тієї ж ролі. */
const CARD_LIMITS = { windowMinutes: 60, maxAttempts: 20, blockMinutes: 60 };

/** «Create my card»: знімок балу ролі з іменем, яке людина підтвердила. */
export async function createCardAction(_prev: ProfileActionState, form: FormData): Promise<ProfileActionState> {
  const user = await requireUser();
  const d = db();
  const role = String(form.get("role") ?? "");
  const name = String(form.get("name") ?? "");
  if (!isRoleKey(role)) return { message: { tone: "error", text: "Unknown role." }, name };

  const row = await d
    .prepare(
      `SELECT s.score, s.formula_version, u.roles FROM scores s JOIN users u ON u.id = s.user_id
        WHERE s.user_id = ? AND s.role = ?`,
    )
    .bind(user.id, role)
    .first<{ score: number | null; formula_version: string; roles: string }>();
  if (!row || row.score === null || !parseRoles(row.roles).includes(role)) {
    return { message: { tone: "error", text: "There is no score for this role yet." }, name };
  }
  const verdict = await consume(`card:${user.id}`, CARD_LIMITS, d);
  if (!verdict.allowed) {
    return { message: { tone: "error", text: `Too many cards. Try again in ${verdict.retryAfterMinutes} minutes.` }, name };
  }

  let slug: string;
  try {
    slug = await createCard(d, {
      userId: user.id,
      role,
      score: row.score,
      displayName: name,
      formulaVersion: row.formula_version,
    });
  } catch (err) {
    if (err instanceof CardInputError) return { message: { tone: "error", text: err.message }, name };
    console.error("createCard failed:", err instanceof Error ? err.message : String(err));
    return { message: { tone: "error", text: "Something went wrong. Try again." }, name };
  }
  await audit(user.id, "card.create", slug, { role });
  redirect(`/c/${slug}`);
}
