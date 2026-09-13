"use server";

import { redirect } from "next/navigation";
import { loadSettings, saveDailyJobs, validateDailyJobs } from "@/lib/account/settings";
import { saveStep } from "@/lib/onboarding/store";
import { field, goNext, stepContext, type StepState } from "../flow";

// Крок анкети «How should we send your jobs?»: канал, година й пояс щоденних вакансій.
// Ті самі перевірки й той самий запис, що в налаштуваннях (lib/account/settings.ts);
// паузу крок не показує й не змінює.

export async function saveDeliveryAction(_prev: StepState, form: FormData): Promise<StepState> {
  const ctx = await stepContext("delivery");
  const settings = await loadSettings(ctx.d, ctx.user.id);
  if (!settings) redirect("/login");
  const res = validateDailyJobs(
    {
      channel: field(form, "channel"),
      hour: field(form, "hour"),
      timezone: field(form, "timezone"),
      paused: settings.digestPaused ? "on" : "",
    },
    { email: settings.email !== null, telegram: settings.telegramLinked },
  );
  if (!res.ok) return { errors: res.errors, message: { tone: "error", text: "Check the fields above." } };
  await saveDailyJobs(ctx.d, ctx.user.id, res.value);
  await saveStep(ctx.d, ctx.user.id, "delivery", {}, ctx.answers.step);
  return goNext(ctx, "delivery");
}
