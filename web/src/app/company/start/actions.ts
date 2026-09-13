"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { FormMessage } from "@/components/form/form-message";
import { getSettings } from "@/lib/admin/settings";
import { requireUser } from "@/lib/auth/session";
import { parseRegistration, registerCompany, userFacingError, type Fields } from "@/lib/crm/company";
import { db } from "@/lib/db";
import { setCurrentCompany } from "../(crm)/crm";

export type StartState = { message?: FormMessage; errors?: Fields; values?: Fields };

const FIELDS = ["name", "website", "country", "hiring_for"] as const;

const COMPANY_SIGNUPS_CLOSED = "New company accounts are closed for now. Try again later.";

/**
 * "Create company" (специфікація 6.1): компанія, власник, прийняті умови.
 * "Our own team" → /company/billing?welcome=1; агенція → форма заявки /company/apply.
 */
export async function registerCompanyAction(_prev: StartState, form: FormData): Promise<StartState> {
  const user = await requireUser();
  const values = Object.fromEntries(FIELDS.map((f) => [f, String(form.get(f) ?? "")]));
  // Нові компанії закрито в /admin/settings (сторінка вже каже про це, але дія мусить перевірити сама).
  if (!(await getSettings(db())).company_signups_open) {
    return { values, message: { tone: "error", text: COMPANY_SIGNUPS_CLOSED } };
  }
  const parsed = parseRegistration(form);
  if (!parsed.ok) {
    return { errors: parsed.errors, values, message: { tone: "error", text: "Check the fields above." } };
  }

  let registered;
  try {
    registered = await registerCompany(db(), { id: user.id, email: user.email }, parsed.value);
  } catch (err) {
    const known = userFacingError(err);
    if (!known) throw err;
    return { values, message: { tone: "error", text: known.message } };
  }

  await setCurrentCompany(registered.companyId);
  revalidatePath("/company", "layout");
  redirect(registered.kind === "agency" ? "/company/apply" : "/company/billing?welcome=1");
}
