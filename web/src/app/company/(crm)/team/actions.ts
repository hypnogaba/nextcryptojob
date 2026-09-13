"use server";

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { FormMessage } from "@/components/form/form-message";
import { requestOrigin } from "@/lib/billing/origin";
import { assertFormCompany, userFacingError } from "@/lib/crm/company";
import { COMPANY_COOKIE, crmActionActor, type ActionContext } from "@/lib/crm/context";
import { changeRole, inviteMember, leaveCompany, removeMember, revokeInvite } from "@/lib/crm/team";
import { appEnv } from "@/lib/db";
import { getMailer } from "@/lib/mail";

/**
 * Дії сторінки команди (специфікація 6.3). Кожна сама визначає актора з сесії
 * (server action це публічна кінцева точка) і перевіряє право через матрицю.
 * Рядкові дії відповідають переходом /company/team?done=… або ?error=…
 */

const PAGE = "/company/team";

export type InviteState = { message?: FormMessage; email?: string; link?: string | null; error?: string };

export async function inviteAction(_prev: InviteState, form: FormData): Promise<InviteState> {
  const email = String(form.get("email") ?? "");
  try {
    const ctx = await crmActionActor();
    assertFormCompany(ctx, form.get("company_id"));
    const res = await inviteMember(ctx, email, {
      origin: requestOrigin(await headers()),
      mailer: getMailer(appEnv()),
    });
    revalidatePath(PAGE);
    return res.emailed
      ? { message: { tone: "success", text: `Invite sent to ${res.email}.` } }
      : {
          email: res.email,
          link: res.link,
          message: { tone: "info", text: `We could not email ${res.email}. Copy the link below and send it yourself.` },
        };
  } catch (err) {
    const known = userFacingError(err);
    if (!known) throw err;
    return { error: known.fields?.email ?? known.message, email };
  }
}

function back(query: string): never {
  redirect(`${PAGE}?${query}`);
}

/**
 * Відповідь рядкової дії: успіх або код відомої помилки в адресі. Актор із сесії;
 * форма мусить бути з тієї самої компанії (друга вкладка могла перемкнути).
 */
async function rowAction(form: FormData, done: string, act: (ctx: ActionContext) => Promise<void>): Promise<never> {
  try {
    const ctx = await crmActionActor();
    assertFormCompany(ctx, form.get("company_id"));
    await act(ctx);
  } catch (err) {
    const known = userFacingError(err);
    if (!known) throw err;
    back(`error=${encodeURIComponent(known.code)}`);
  }
  revalidatePath("/company", "layout");
  back(`done=${done}`);
}

export async function changeRoleAction(form: FormData): Promise<void> {
  const userId = String(form.get("user_id") ?? "");
  const role = form.get("role") === "owner" ? "owner" : "member";
  await rowAction(form, role === "owner" ? "made_owner" : "made_member", (ctx) => changeRole(ctx, userId, role));
}

export async function removeMemberAction(form: FormData): Promise<void> {
  const userId = String(form.get("user_id") ?? "");
  await rowAction(form, "removed", (ctx) => removeMember(ctx, userId));
}

export async function revokeInviteAction(form: FormData): Promise<void> {
  const id = Number(form.get("invite_id"));
  await rowAction(form, "invite_canceled", (ctx) => revokeInvite(ctx, Number.isInteger(id) ? id : -1));
}

/**
 * "Leave the team" (з команди, а для компанії не в стані active з налаштувань):
 * після виходу кукі на цю компанію знято, і людина йде на /company/start.
 * Помилка повертає на сторінку, з якої прийшла форма (`from`).
 */
export async function leaveAction(form: FormData): Promise<void> {
  let companyId: string | null = null;
  const from = form.get("from") === "settings" ? "/company/settings" : PAGE;
  try {
    const ctx = await crmActionActor();
    assertFormCompany(ctx, form.get("company_id"));
    companyId = ctx.company?.id ?? null;
    await leaveCompany(ctx);
  } catch (err) {
    const known = userFacingError(err);
    if (!known) throw err;
    redirect(`${from}?error=${encodeURIComponent(known.code)}`);
  }
  const jar = await cookies();
  if (companyId && jar.get(COMPANY_COOKIE)?.value === companyId) jar.delete(COMPANY_COOKIE);
  revalidatePath("/company", "layout");
  redirect("/company/start");
}
