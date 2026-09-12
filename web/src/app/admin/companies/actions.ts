"use server";

import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { grantManualAccess, MANUAL_STATUSES, revokeManualAccess, type ManualStatus } from "@/lib/billing/manual";
import { db } from "@/lib/db";
import { isId } from "@/lib/ids";

/**
 * Дії адміна над доступом компанії. Server action це публічна кінцева точка,
 * тож кожна дія сама перевіряє адміна (lib/auth/admin.ts), а не покладається
 * на сторінку. Результат іде в адресу: /admin/companies?done=… або ?error=….
 */

const PAGE = "/admin/companies";

export type AdminError =
  | "not_admin"
  | "not_found"
  | "invalid_status"
  | "invalid_period"
  | "note_required"
  | "note_too_long";

function back(query: string): never {
  redirect(`${PAGE}?${query}`);
}

async function admin(): Promise<string> {
  const user = await currentAdmin();
  if (!user) back("error=not_admin");
  return user.id;
}

/** Дата з поля форми `YYYY-MM-DD`: доступ до кінця цього дня UTC. */
function endOfDay(value: FormDataEntryValue | null): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T23:59:59Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : d;
}

export async function grantAccessAction(form: FormData): Promise<void> {
  const adminId = await admin();
  const companyId = form.get("company_id");
  if (!isId("co", companyId)) back("error=not_found");
  const status = String(form.get("status") ?? "");
  if (!(MANUAL_STATUSES as readonly string[]).includes(status)) back(`error=invalid_status&company=${companyId}`);
  const periodEnd = endOfDay(form.get("period_end"));
  if (!periodEnd) back(`error=invalid_period&company=${companyId}`);

  const res = await grantManualAccess(db(), {
    companyId,
    status: status as ManualStatus,
    periodEnd,
    note: String(form.get("note") ?? ""),
    adminUserId: adminId,
  });
  if (!res.ok) back(`error=${res.reason}&company=${companyId}`);
  back(`done=granted&company=${companyId}`);
}

export async function revokeAccessAction(form: FormData): Promise<void> {
  const adminId = await admin();
  const companyId = form.get("company_id");
  if (!isId("co", companyId)) back("error=not_found");
  const res = await revokeManualAccess(db(), { companyId, adminUserId: adminId });
  if (!res.ok) back(`error=${res.reason}&company=${companyId}`);
  back(`done=revoked&company=${companyId}`);
}
