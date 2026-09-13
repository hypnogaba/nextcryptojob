"use server";

import { redirect } from "next/navigation";
import { markXPosted, setJobHidden, skipXPost } from "@/lib/admin/jobs";
import { currentAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { isId } from "@/lib/ids";

/**
 * Дії адміна над вакансіями компаній: "Hide" / "Unhide" (/admin/jobs) і "Mark as posted"
 * / "Skip" (/admin/x-queue). Server action це публічна кінцева точка, тож кожна дія сама
 * перевіряє адміна (lib/auth/admin.ts: пошта з ADMIN_EMAILS і вхід поштою). Результат іде
 * в адресу: ?done=… або ?error=….
 */

function back(page: "/admin/jobs" | "/admin/x-queue", query: string): never {
  redirect(`${page}?${query}`);
}

async function jobAction(
  page: "/admin/jobs" | "/admin/x-queue",
  form: FormData,
  run: (jobId: string, adminUserId: string) => Promise<{ ok: true } | { ok: false; reason: string }>,
  done: string,
): Promise<never> {
  const user = await currentAdmin();
  if (!user) back(page, "error=not_admin");
  const jobId = form.get("job_id");
  if (!isId("job", jobId)) back(page, "error=not_found");
  const res = await run(jobId, user.id);
  if (!res.ok) back(page, `error=${res.reason}&job=${jobId}`);
  back(page, `done=${done}&job=${jobId}`);
}

export async function hideJobAction(form: FormData): Promise<void> {
  await jobAction("/admin/jobs", form, (jobId, adminUserId) => setJobHidden(db(), { jobId, adminUserId, hidden: true }), "hidden");
}

export async function unhideJobAction(form: FormData): Promise<void> {
  await jobAction("/admin/jobs", form, (jobId, adminUserId) => setJobHidden(db(), { jobId, adminUserId, hidden: false }), "unhidden");
}

export async function markXPostedAction(form: FormData): Promise<void> {
  const url = String(form.get("url") ?? "").slice(0, 300);
  await jobAction("/admin/x-queue", form, (jobId, adminUserId) => markXPosted(db(), { jobId, adminUserId, url }), "posted");
}

export async function skipXPostAction(form: FormData): Promise<void> {
  await jobAction("/admin/x-queue", form, (jobId, adminUserId) => skipXPost(db(), { jobId, adminUserId }), "skipped");
}
