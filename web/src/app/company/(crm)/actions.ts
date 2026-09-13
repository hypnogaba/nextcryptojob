"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { CRM_HOME, listMemberships, touchMember } from "@/lib/crm/company";
import { limitWebActions, type CrmEnv } from "@/lib/crm/context";
import { appEnv, db } from "@/lib/db";
import { isId } from "@/lib/ids";
import { setCurrentCompany } from "./crm";

/**
 * Перемикач компаній (специфікація 3.3): кукі `ncj_company` лише на компанію,
 * де людина член; чужий id нічого не змінює. revalidatePath чистить і кеш
 * роутера в браузері, тож сторінки одразу показують нову компанію.
 */

/** Лише свої сторінки CRM, без відкритих переходів на чужі адреси. */
function safeNext(value: FormDataEntryValue | null): string {
  if (typeof value !== "string" || !/^\/company\/[a-z-]+(?:\/[A-Za-z0-9_-]+)*$/.test(value)) return CRM_HOME;
  if (value.startsWith("/company/join") || value.startsWith("/company/start")) return CRM_HOME;
  return value;
}

export async function switchCompanyAction(form: FormData): Promise<void> {
  const user = await requireUser();
  const companyId = form.get("company_id");
  const next = safeNext(form.get("next"));
  try {
    await limitWebActions(appEnv() as unknown as CrmEnv, user.id);
  } catch {
    // Забагато дій за хвилину (RL_WEB): компанію не перемикаємо.
    redirect(next);
  }
  if (!isId("co", companyId)) redirect(next);
  const d = db();
  const mine = (await listMemberships(d, user.id)).some((m) => m.companyId === companyId);
  if (!mine) redirect(next);
  await setCurrentCompany(companyId);
  await touchMember(d, user.id, companyId, true);
  revalidatePath("/company", "layout");
  redirect(next);
}
