"use server";

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { FormMessage } from "@/components/form/form-message";
import { requestOrigin } from "@/lib/billing/origin";
import { userFacingError } from "@/lib/crm/company";
import { COMPANY_COOKIE, resolveWebActor } from "@/lib/crm/context";
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
    const res = await inviteMember(await resolveWebActor(), email, {
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

/** Відповідь рядкової дії: успіх або код відомої помилки в адресі. */
async function rowAction(done: string, act: () => Promise<void>): Promise<never> {
  try {
    await act();
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
  await rowAction(role === "owner" ? "made_owner" : "made_member", async () => changeRole(await resolveWebActor(), userId, role));
}

export async function removeMemberAction(form: FormData): Promise<void> {
  const userId = String(form.get("user_id") ?? "");
  await rowAction("removed", async () => removeMember(await resolveWebActor(), userId));
}

export async function revokeInviteAction(form: FormData): Promise<void> {
  const id = Number(form.get("invite_id"));
  await rowAction("invite_canceled", async () => revokeInvite(await resolveWebActor(), Number.isInteger(id) ? id : -1));
}

/** "Leave the team": після виходу кукі на цю компанію знято, і людина йде на /company/start. */
export async function leaveAction(): Promise<void> {
  let companyId: string | null = null;
  try {
    const ctx = await resolveWebActor();
    companyId = ctx.company?.id ?? null;
    await leaveCompany(ctx);
  } catch (err) {
    const known = userFacingError(err);
    if (!known) throw err;
    back(`error=${encodeURIComponent(known.code)}`);
  }
  const jar = await cookies();
  if (companyId && jar.get(COMPANY_COOKIE)?.value === companyId) jar.delete(COMPANY_COOKIE);
  revalidatePath("/company", "layout");
  redirect("/company/start");
}
