"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { isJobRef, saveJob, unsaveJob } from "@/lib/jobs/saved";

/** Кнопка «Save» на картці вакансії (раунд 5, п.16): save=true зберігає, false прибирає. */
export async function toggleSaveJobAction(ref: string, save: boolean): Promise<{ ok: boolean }> {
  const user = await requireUser();
  if (!isJobRef(ref)) return { ok: false };
  const d = db();
  if (save) await saveJob(d, user.id, ref);
  else await unsaveJob(d, user.id, ref);
  revalidatePath("/jobs");
  return { ok: true };
}
