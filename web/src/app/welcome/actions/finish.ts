"use server";

import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { grantConsent, SCORING_CONSENT } from "@/lib/consent";
import { saveStep } from "@/lib/onboarding/store";
import { enqueueScoreJob } from "@/lib/score/queue";
import { field, stepContext, type StepState } from "../flow";

// Останній крок анкети: згода на бал, перше завдання в чергу й одразу вакансії на /jobs.
// Добірка engine бере лише людей з рядком у scores, а він з'являється після першого
// перерахунку, тож згода стоїть тут, до необов'язкових кроків «Stand out».

export async function finishAction(_prev: StepState, form: FormData): Promise<StepState> {
  const ctx = await stepContext("consent");
  if (ctx.answers.roles.length === 0) redirect("/welcome?step=roles");
  if (field(form, "agree") !== "yes") {
    return { errors: { agree: "Tick the box to continue. We compute a score only with your consent." } };
  }
  if (await grantConsent(ctx.d, ctx.user.id, SCORING_CONSENT.kind, SCORING_CONSENT.version)) {
    await audit(ctx.user.id, "consent.grant", ctx.user.id, { kind: SCORING_CONSENT.kind, version: SCORING_CONSENT.version });
  }
  // Досягнутий крок: перший крок «Stand out» (або лишається «done» при редагуванні).
  await saveStep(ctx.d, ctx.user.id, "consent", {}, ctx.answers.step);
  // Правило 60 с і «не дублювати» стежить сама черга; тут результат не важливий.
  await enqueueScoreJob(ctx.d, ctx.user.id, "connect");
  redirect("/jobs");
}
