"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runAction } from "@/lib/crm/actions";
import { assertFormCompany, userFacingError } from "@/lib/crm/company";
import { resolveWebActor } from "@/lib/crm/context";
import { isId } from "@/lib/ids";
import { ActionError } from "@/lib/crm/types";

/**
 * Дії сторінки збережених пошуків: перемикач "Daily alert" і "Delete" через
 * реєстр дій (update_saved_search, delete_saved_search). Актор із сесії,
 * прихований id компанії порівнюється з компанією сесії.
 */

const PAGE = "/company/saved-searches";

async function act(form: FormData, done: string, run: (ctx: Awaited<ReturnType<typeof resolveWebActor>>, id: string) => Promise<unknown>): Promise<never> {
  const id = form.get("saved_search_id");
  try {
    const ctx = await resolveWebActor();
    assertFormCompany(ctx, form.get("company_id"));
    if (!isId("ss", id)) throw new ActionError("not_found", 404, "This saved search was not found.");
    await run(ctx, id);
  } catch (err) {
    const known = userFacingError(err);
    if (!known) throw err;
    redirect(`${PAGE}?error=${encodeURIComponent(known.code)}`);
  }
  revalidatePath(PAGE);
  redirect(`${PAGE}?done=${done}`);
}

export async function toggleAlertAction(form: FormData): Promise<void> {
  const alert = form.get("alert") === "daily" ? "daily" : "off";
  await act(form, alert === "daily" ? "alert_on" : "alert_off", (ctx, id) =>
    runAction("update_saved_search", { saved_search_id: id, alert }, ctx),
  );
}

export async function deleteSavedSearchAction(form: FormData): Promise<void> {
  await act(form, "deleted", (ctx, id) => runAction("delete_saved_search", { saved_search_id: id }, ctx));
}
