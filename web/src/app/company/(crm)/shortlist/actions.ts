"use server";

import { redirect } from "next/navigation";
import { assertFormCompany, userFacingError } from "@/lib/crm/company";
import { crmActionActor } from "@/lib/crm/context";
import { BRIEF_MAX, briefFromText, briefQuery } from "@/lib/crm/brief";

/**
 * "Find people" на сторінці шортлиста: текст вакансії → бриф → адреса з фільтрами.
 * Сам текст не зберігаємо й не кладемо в адресу: лише те, що з нього прочитали.
 * Пошук робить сторінка (одна сторінка пошуку з денної квоти).
 */
export async function briefAction(form: FormData): Promise<void> {
  const raw = form.get("brief");
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text.length < 3) redirect("/company/shortlist?error=empty");
  if (text.length > BRIEF_MAX) redirect("/company/shortlist?error=long");
  try {
    const ctx = await crmActionActor();
    assertFormCompany(ctx, form.get("company_id"));
  } catch (err) {
    const known = userFacingError(err);
    if (!known) throw err;
    redirect(`/company/shortlist?error=${encodeURIComponent(known.code)}`);
  }
  const brief = briefFromText(text);
  const cityRaw = form.get("city");
  const city = typeof cityRaw === "string" ? cityRaw.trim().slice(0, 80) : "";
  if (city) {
    brief.work = "city";
    brief.city = city;
  }
  if (brief.roles.length === 0) redirect("/company/shortlist?error=no_role");
  redirect(`/company/shortlist?${briefQuery(brief)}`);
}
