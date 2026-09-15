"use server";

import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { enqueueScoreJob } from "@/lib/score/queue";

function back(userId: string, query: string): never {
  redirect(`/admin/scores/${userId}?${query}`);
}

/** «Rescore now»: та сама черга, що кнопка «Update my score» на сторінці кандидата. */
export async function rescoreNowAction(form: FormData): Promise<void> {
  const admin = await currentAdmin();
  const userId = String(form.get("user_id") ?? "");
  if (!admin) back(userId, "error=not_admin");
  const res = await enqueueScoreJob(db(), userId, "manual");
  if (res.ok) back(userId, "done=queued");
  switch (res.reason) {
    case "already_queued":
      back(userId, "error=already_queued");
    case "too_soon":
      back(userId, `error=too_soon&wait=${res.retryAfterSeconds}`);
    case "no_consent":
      back(userId, "error=no_consent");
  }
}
