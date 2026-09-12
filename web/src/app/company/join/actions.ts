"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { CRM_HOME, userFacingError } from "@/lib/crm/company";
import { acceptInvite } from "@/lib/crm/team";
import { db } from "@/lib/db";
import { setCurrentCompany } from "../(crm)/crm";

/**
 * "Join" на /company/join (специфікація 6.3). Лише POST: сканери пошти
 * відкривають посилання GET, і запрошення не має прийматися саме.
 */
export async function acceptInviteAction(form: FormData): Promise<void> {
  const user = await requireUser();
  const token = String(form.get("t") ?? "");
  let companyId: string;
  try {
    ({ companyId } = await acceptInvite(db(), { id: user.id, email: user.email }, token));
  } catch (err) {
    const known = userFacingError(err);
    if (!known) throw err;
    redirect(`/company/join?t=${encodeURIComponent(token)}&error=${encodeURIComponent(known.code)}`);
  }
  await setCurrentCompany(companyId);
  revalidatePath("/company", "layout");
  redirect(CRM_HOME);
}
