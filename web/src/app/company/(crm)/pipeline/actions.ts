"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runAction } from "@/lib/crm/actions";
import { assertFormCompany, userFacingError } from "@/lib/crm/company";
import { crmActionActor } from "@/lib/crm/context";
import { isId } from "@/lib/ids";
import { ActionError, CandidateId, type Stage } from "@/lib/crm/types";

/**
 * Дії воронки (W4): "Move to..." і "Withdraw". Актор із сесії, прихований id
 * компанії порівнюється з компанією сесії, зміна йде через реєстр дій
 * (update_stage, cancel_intro). Відповідь: перехід назад на ту саму сторінку
 * з ?done=… або ?error=<код>; без JS теж працює.
 */

const MOVABLE: readonly Stage[] = ["found", "interview", "hired", "declined"];

/** Адреса повернення: лише наші сторінки воронки й лише відомі параметри. */
function backUrl(form: FormData, extra: Record<string, string>): string {
  const page = form.get("from") === "intros" ? "/company/pipeline/intros" : "/company/pipeline";
  const q = new URLSearchParams();
  for (const key of ["view", "job", "tag", "status"]) {
    const v = form.get(key);
    if (typeof v === "string" && v && v.length <= 64) q.set(key, v);
  }
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return `${page}?${q.toString()}`;
}

async function act(form: FormData, done: string, run: (ctx: Awaited<ReturnType<typeof crmActionActor>>) => Promise<unknown>): Promise<never> {
  try {
    const ctx = await crmActionActor();
    assertFormCompany(ctx, form.get("company_id"));
    await run(ctx);
  } catch (err) {
    const known = userFacingError(err);
    if (!known) throw err;
    redirect(backUrl(form, { error: known.code }));
  }
  revalidatePath("/company/pipeline", "layout");
  redirect(backUrl(form, { done }));
}

export async function moveCardAction(form: FormData): Promise<void> {
  const candidateId = String(form.get("candidate_id") ?? "");
  const stage = String(form.get("stage") ?? "") as Stage;
  await act(form, "moved", async (ctx) => {
    if (!CandidateId.safeParse(candidateId).success) throw new ActionError("not_found", 404, "This candidate is not in your pipeline.");
    if (!MOVABLE.includes(stage)) throw new ActionError("validation_failed", 422, "Choose where to move the card.");
    await runAction("update_stage", { candidate_id: candidateId, stage }, ctx);
  });
}

export async function withdrawIntroAction(form: FormData): Promise<void> {
  const introId = form.get("intro_id");
  await act(form, "withdrawn", async (ctx) => {
    if (!isId("int", introId)) throw new ActionError("not_found", 404, "This intro was not found.");
    await runAction("cancel_intro", { intro_id: introId }, ctx);
  });
}
