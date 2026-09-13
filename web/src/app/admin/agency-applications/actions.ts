"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { requestOrigin } from "@/lib/billing/origin";
import { reviewApplication, type ReviewDecision } from "@/lib/crm/agency";
import { appEnv, db } from "@/lib/db";
import { isId } from "@/lib/ids";
import { getMailer } from "@/lib/mail";

/**
 * Рішення щодо заявок агенцій (специфікація 6.2, 12). Кожна дія сама перевіряє
 * адміна (server action це публічна кінцева точка). Результат іде в адресу.
 */

const PAGE = "/admin/agency-applications";

function back(query: string): never {
  redirect(`${PAGE}?${query}`);
}

export async function reviewApplicationAction(form: FormData): Promise<void> {
  const admin = await currentAdmin();
  if (!admin) back("error=not_admin");
  const applicationId = form.get("application_id");
  if (!isId("app", applicationId)) back("error=not_found");
  const decision = String(form.get("decision") ?? "") as ReviewDecision;
  const res = await reviewApplication(
    db(),
    { userId: admin.id },
    { applicationId, decision, note: String(form.get("note") ?? "") },
    { mailer: getMailer(appEnv()), origin: requestOrigin(await headers()) },
  );
  if (!res.ok) back(`error=${res.reason}&app=${applicationId}`);
  revalidatePath(PAGE);
  back(`done=${res.status}&app=${applicationId}&emailed=${res.emailed ? 1 : 0}`);
}
