"use server";

import { redirect } from "next/navigation";
import { markRefunded } from "@/lib/admin/payments";
import { currentAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { isId } from "@/lib/ids";

/**
 * Дія адміна над платежем без результату. Server action це публічна кінцева точка,
 * тож дія сама перевіряє адміна (lib/auth/admin.ts). Результат іде в адресу:
 * /admin/payments?done=refunded або ?error=….
 */

const PAGE = "/admin/payments";

export type PaymentsAdminError = "not_admin" | "not_found" | "note_required" | "note_too_long";

function back(query: string): never {
  redirect(`${PAGE}?${query}`);
}

export async function markRefundedAction(form: FormData): Promise<void> {
  const user = await currentAdmin();
  if (!user) back("error=not_admin");
  const paymentId = form.get("payment_id");
  if (!isId("pay", paymentId)) back("error=not_found");
  const res = await markRefunded(db(), { paymentId, adminUserId: user.id, note: String(form.get("note") ?? "") });
  if (!res.ok) back(`error=${res.reason}&payment=${paymentId}`);
  back(`done=refunded&payment=${paymentId}`);
}
