"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { FormMessage } from "@/components/form/form-message";
import { stripeClient, type StripeEnv } from "@/lib/billing/stripe";
import {
  assertFormCompany,
  CLOSE_CONFIRM_WORD,
  closeCompany,
  parseSettings,
  updateCompanySettings,
  userFacingError,
  type Fields,
} from "@/lib/crm/company";
import { COMPANY_COOKIE, resolveWebActor } from "@/lib/crm/context";
import { appEnv } from "@/lib/db";

export type CompanySettingsState = { message?: FormMessage; errors?: Fields; values?: Fields };

const PROFILE_FIELDS = ["name", "website", "country", "about", "x_handle"] as const;

/** "Company profile": назва, сайт (і перевірка домену), країна, About, X. Лише власник. */
export async function updateCompanySettingsAction(_prev: CompanySettingsState, form: FormData): Promise<CompanySettingsState> {
  const values = Object.fromEntries(PROFILE_FIELDS.map((f) => [f, String(form.get(f) ?? "")]));
  const parsed = parseSettings(form);
  if (!parsed.ok) return { errors: parsed.errors, values, message: { tone: "error", text: "Check the fields above." } };
  let res;
  try {
    const ctx = await resolveWebActor();
    assertFormCompany(ctx, form.get("company_id"));
    res = await updateCompanySettings(ctx, parsed.value);
  } catch (err) {
    const known = userFacingError(err);
    if (!known) throw err;
    return { errors: known.fields, values, message: { tone: "error", text: known.message } };
  }
  revalidatePath("/company", "layout");
  if (res.changed.length === 0) return { message: { tone: "info", text: "Nothing changed." } };
  return { message: { tone: "success", text: "Saved." } };
}

/**
 * "Close company" (10.2, 11). Підтвердження словом CLOSE. Stripe скасовується
 * першим; не вдалося, тоді компанія лишається відкритою й людина бачить чому.
 */
export async function closeCompanyAction(_prev: CompanySettingsState, form: FormData): Promise<CompanySettingsState> {
  if (String(form.get("confirm") ?? "").trim() !== CLOSE_CONFIRM_WORD) {
    return { errors: { confirm: `Type ${CLOSE_CONFIRM_WORD} to confirm.` } };
  }
  let closedId: string | null = null;
  try {
    // Актор усередині try: сесія, що скінчилась (401), дає текст, а не сторінку помилки.
    const ctx = await resolveWebActor();
    assertFormCompany(ctx, form.get("company_id"));
    await closeCompany(ctx, { stripe: stripeClient(appEnv() as unknown as StripeEnv) });
    closedId = ctx.company?.id ?? null;
  } catch (err) {
    const known = userFacingError(err);
    if (!known) throw err;
    return { message: { tone: "error", text: known.message } };
  }
  // Кукі на закриту компанію більше не потрібна: наступний запит візьме іншу, якщо вона є.
  const jar = await cookies();
  if (closedId && jar.get(COMPANY_COOKIE)?.value === closedId) jar.delete(COMPANY_COOKIE);
  revalidatePath("/company", "layout");
  redirect("/company/settings");
}
