"use server";

import { redirect } from "next/navigation";
import { createDemo, deleteDemo } from "@/lib/admin/demo";
import { runWeeklyReport } from "@/lib/admin/weekly";
import { currentAdmin } from "@/lib/auth/admin";
import { notifierFromEnv } from "@/lib/crm/notify";
import { appEnv, db } from "@/lib/db";
import { jobsDb } from "@/lib/jobs-db";
import { setCurrentCompany } from "../company/(crm)/crm";

/**
 * Дії службової сторінки адмінки (/admin/health): щотижневий звіт зараз, демо-компанія.
 * Server action це публічна кінцева точка, тож кожна дія сама перевіряє адміна. Результат іде
 * в адресу (?done=… або ?error=…), як у /admin/settings.
 */

function back(query: string, hash = ""): never {
  redirect(`/admin/health?${query}${hash}`);
}

export async function sendWeeklyNowAction(): Promise<void> {
  const admin = await currentAdmin();
  if (!admin) back("error=not_admin");
  const env = appEnv() as { ADMIN_EMAILS?: string; TELEGRAM_BOT_TOKEN?: string; EMAIL?: SendEmail; SITE_URL?: string };
  let jobs = null;
  try {
    jobs = jobsDb();
  } catch {
    // Без бази вакансій звіт іде без блоку сканера.
  }
  const res = await runWeeklyReport(db(), { jobs, notifier: notifierFromEnv(env), adminEmails: env.ADMIN_EMAILS, force: true });
  if (!res.sent) {
    back(`error=weekly&why=${encodeURIComponent(res.skipped ?? res.errors.join("; ").slice(0, 200))}`, "#owner");
  }
  back(`done=weekly&ch=${encodeURIComponent(res.channels.join(","))}${res.errors.length ? `&why=${encodeURIComponent(res.errors.join("; ").slice(0, 200))}` : ""}`, "#owner");
}

export async function createDemoAction(): Promise<void> {
  const admin = await currentAdmin();
  if (!admin) back("error=not_admin");
  const res = await createDemo(db(), admin.id);
  back(`done=demo_created&n=${res.candidates}${res.created ? "" : "&existing=1"}`, "#demo");
}

/** Відкрити CRM демо-компанії: вона стає поточною (кукі ncj_company), далі пошук. */
export async function openDemoAction(form: FormData): Promise<void> {
  const admin = await currentAdmin();
  if (!admin) back("error=not_admin");
  const id = String(form.get("company_id") ?? "");
  const ok = await db()
    .prepare(
      `SELECT 1 AS yes FROM companies c JOIN company_members m ON m.company_id = c.id AND m.user_id = ?
        WHERE c.id = ? AND c.is_demo = 1`,
    )
    .bind(admin.id, id)
    .first();
  if (!ok) back("error=demo_missing", "#demo");
  await setCurrentCompany(id);
  redirect("/company/search");
}

export async function deleteDemoAction(): Promise<void> {
  const admin = await currentAdmin();
  if (!admin) back("error=not_admin");
  const res = await deleteDemo(db(), admin.id);
  back(`done=demo_deleted&n=${res.candidates}&c=${res.companies}`, "#demo");
}
