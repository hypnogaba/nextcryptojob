"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { FormMessage } from "@/components/form/form-message";
import { agencyAlert, sendOwnerAlert } from "@/lib/admin/alerts";
import { parseApplication, submitApplication } from "@/lib/crm/agency";
import { assertFormCompany, userFacingError, type Fields } from "@/lib/crm/company";
import { crmActionActor } from "@/lib/crm/context";
import { notifierFromEnv } from "@/lib/crm/notify";

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
    const res = await submitApplication(ctx, parsed.value);
    // Власнику одразу (Telegram або пошта), не чекаючи щогодинної перевірки. Той самий ключ
    // дедуплікації, тож cron удруге не надішле. Збій сповіщення заявку не зупиняє.
    if (ctx.company) {
      try {
        await sendOwnerAlert(
          ctx.db,
          agencyAlert({ id: res.applicationId, company: ctx.company.name, country: parsed.value.country, resubmitted: res.resubmitted }),
          { notifier: notifierFromEnv(ctx.env), adminEmails: (ctx.env as { ADMIN_EMAILS?: string }).ADMIN_EMAILS },
        );
      } catch (error) {
        console.error("agency application: owner not notified", error instanceof Error ? error.message : String(error));
      }
    }
  } catch (err) {
    const known = userFacingError(err);
    if (!known) throw err;
    return { values, message: { tone: "error", text: known.message } };
  }
  revalidatePath("/company", "layout");
  redirect("/company/apply");
}
