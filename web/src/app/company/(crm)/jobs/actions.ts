"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { FormMessage } from "@/components/form/form-message";
import { runAction } from "@/lib/crm/actions";
import { assertFormCompany, userFacingError } from "@/lib/crm/company";
import { crmActionActor } from "@/lib/crm/context";
import { formFieldErrors, jobInputOf, readJobForm, type JobFormValues } from "@/lib/crm/job-form";
import type { Job } from "@/lib/crm/jobs";
import { ActionError } from "@/lib/crm/types";
import { isId } from "@/lib/ids";

/**
 * Дії екранів вакансій (специфікація 10.2): "Save draft" / "Publish" / "Save" з форми
 * і "Close" зі списку чи сторінки вакансії. Актор із сесії з лімітом RL_WEB
 * (crmActionActor), прихований id компанії порівнюється з компанією сесії (друга
 * вкладка могла перемкнути компанію), далі реєстр дій: право, доступ, поля, журнал.
 */

const LIST = "/company/jobs";

export type JobFormState = { message?: FormMessage; errors?: Record<string, string>; values?: JobFormValues };

/**
 * Нова вакансія (job_id порожній) або зміна наявної. `intent`: "draft" (лише для
 * нової чи чернетки), "open" (Publish, Publish again) або "save" (без зміни стану).
 */
export async function saveJobAction(_prev: JobFormState, form: FormData): Promise<JobFormState> {
  const values = readJobForm(form);
  const intent = form.get("intent");
  const jobId = form.get("job_id");
  const parsed = jobInputOf(values);
  if ("errors" in parsed) return { errors: parsed.errors, values, message: { tone: "error", text: "Check the fields above." } };

  let job: Job;
  try {
    const ctx = await crmActionActor();
    assertFormCompany(ctx, form.get("company_id"));
    const status = intent === "open" ? "open" : intent === "draft" ? "draft" : undefined;
    if (typeof jobId === "string" && jobId !== "") {
      if (!isId("job", jobId)) return { values, message: { tone: "error", text: "This job was not found." } };
      job = (await runAction("update_job", { job_id: jobId, ...parsed.input, ...(status ? { status } : {}) }, ctx)).output as Job;
    } else {
      job = (await runAction("post_job", { ...parsed.input, status: status ?? "draft" }, ctx)).output as Job;
    }
  } catch (err) {
    const known = userFacingError(err);
    if (!known) throw err;
    const errors = formFieldErrors(known.fields);
    const text = Object.keys(errors).length > 0 ? "Check the fields above." : known.message;
    return { errors, values, message: { tone: "error", text } };
  }
  revalidatePath(LIST, "layout");
  const done = intent === "open" ? "job_published" : typeof jobId === "string" && jobId !== "" ? "job_saved" : "job_draft";
  redirect(`${LIST}?done=${done}&job=${job.job_id}`);
}

/** "Close job": з добірок, пошуку й черги X одразу. Повертає туди, звідки закривали. */
export async function closeJobAction(form: FormData): Promise<void> {
  const jobId = form.get("job_id");
  const back = form.get("back") === "job" && isId("job", jobId) ? `${LIST}/${jobId}` : LIST;
  try {
    const ctx = await crmActionActor();
    assertFormCompany(ctx, form.get("company_id"));
    if (!isId("job", jobId)) throw new ActionError("not_found", 404, "This job was not found.");
    await runAction("close_job", { job_id: jobId }, ctx);
  } catch (err) {
    const known = userFacingError(err);
    if (!known) throw err;
    redirect(`${back}?error=${encodeURIComponent(known.code)}`);
  }
  revalidatePath(LIST, "layout");
  redirect(`${back}?done=job_closed`);
}
