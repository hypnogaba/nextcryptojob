"use server";

import { redirect } from "next/navigation";
import { acceptTerms, loadSettings, saveDailyJobs, validateDailyJobs } from "@/lib/account/settings";
import { audit } from "@/lib/audit";
import { TERMS_ACCEPTANCE } from "@/lib/consent";
import { saveStep } from "@/lib/onboarding/store";
import { enqueueScoreJob } from "@/lib/score/queue";
import { field, goNext, stepContext, type StepState } from "../flow";

// Крок анкети «How should we send your jobs?»: канал, година й пояс щоденних вакансій.
// Ті самі перевірки й той самий запис, що в налаштуваннях (lib/account/settings.ts);
// паузу крок не показує й не змінює.
//
// Це остання кнопка анкети (власник 14.09, раунд 3: окремий крок згоди з двома галками прибрано).
// Під нею рядок «By continuing you agree to the Terms and Privacy.»; у першому проході натискання
// приймає умови однією подією (acceptTerms: бал, видимість і нік напряму за замовчуванням, вимкнути
// в налаштуваннях) і ставить перший бал у чергу. Добірка engine бере лише людей з рядком у scores,
// тож перше завдання стоїть тут: добірка піде, навіть якщо людина зупиниться на кроці X.

export async function saveDeliveryAction(_prev: StepState, form: FormData): Promise<StepState> {
  const ctx = await stepContext("delivery");
  if (ctx.answers.roles.length === 0) redirect("/welcome?step=roles");
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
  if (!ctx.briefDone) {
    const terms = await acceptTerms(ctx.d, ctx.user.id);
    if (terms.accepted) await audit(ctx.user.id, "terms.accept", ctx.user.id, { version: TERMS_ACCEPTANCE.version });
  }
  await saveStep(ctx.d, ctx.user.id, "delivery", {}, ctx.answers.step);
  // Правило 60 с і «не дублювати» стежить сама черга; тут результат не важливий.
  if (!ctx.briefDone) await enqueueScoreJob(ctx.d, ctx.user.id, "connect");
  return goNext(ctx, "delivery");
}
