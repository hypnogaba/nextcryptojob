"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { FormMessage } from "@/components/form/form-message";
import { parseApplication, submitApplication } from "@/lib/crm/agency";
import { assertFormCompany, userFacingError, type Fields } from "@/lib/crm/company";
import { crmActionActor } from "@/lib/crm/context";

export type ApplyState = { message?: FormMessage; errors?: Fields; values?: Fields };

const FIELDS = ["contact_name", "contact_email", "website", "country", "clients_text", "volume_text", "data_use_text"] as const;

/** Подати заявку агенції або оновити її після "Ask for more info" (специфікація 6.2). */
export async function submitApplicationAction(_prev: ApplyState, form: FormData): Promise<ApplyState> {
  const values = Object.fromEntries(FIELDS.map((f) => [f, String(form.get(f) ?? "")]));
  const parsed = parseApplication(form);
  if (!parsed.ok) return { errors: parsed.errors, values, message: { tone: "error", text: "Check the fields above." } };
  try {
    const ctx = await crmActionActor();
    assertFormCompany(ctx, form.get("company_id"));
    await submitApplication(ctx, parsed.value);
  } catch (err) {
    const known = userFacingError(err);
    if (!known) throw err;
    return { values, message: { tone: "error", text: known.message } };
  }
  revalidatePath("/company", "layout");
  redirect("/company/apply");
}
