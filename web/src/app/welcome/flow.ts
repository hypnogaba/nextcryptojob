import { redirect } from "next/navigation";
import type { FormMessage } from "@/components/form/form-message";
import { consume, type Limits } from "@/lib/auth/ratelimit";
import { requireUser, type SessionUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { loadAnswers, type Answers } from "@/lib/onboarding/store";
import { canVisit, nextStep, type Step } from "@/lib/onboarding/steps";
import { enqueueScoreJob } from "@/lib/score/queue";

/**
 * Спільне для дій анкети: хто, чи можна на цей крок, куди далі.
 * Не "use server": тут звичайні помічники, дії живуть у actions/.
 */

export type StepState = {
  message?: FormMessage;
  /** Помилки по полях (ключ = name поля або адреса гаманця). */
  errors?: Record<string, string>;
  /** Що людина ввела: форма після дії скидається, і ці значення повертаються в поля. */
  values?: Record<string, string>;
};

export type StepContext = { user: SessionUser; d: D1Database; answers: Answers; wasDone: boolean };

/**
 * Людина, база й відповіді для дії кроку. Дію можна викликати й запитом
 * в обхід сторінки, тож крок, до якого людина ще не дійшла, відсилає назад.
 */
export async function stepContext(step: Step): Promise<StepContext> {
  const user = await requireUser();
  const d = db();
  const answers = await loadAnswers(d, user.id);
  if (!canVisit(step, answers.step)) redirect("/welcome");
  return { user, d, answers, wasDone: answers.step === "done" };
}

/**
 * Після збереження кроку: під час анкети на наступний крок; після неї назад
 * у профіль, і якщо змінились джерела чи ролі, бал ставиться в чергу.
 */
export async function goNext(ctx: StepContext, completed: Step, rescore: boolean): Promise<never> {
  if (ctx.wasDone) {
    if (rescore) await enqueueScoreJob(ctx.d, ctx.user.id, "connect");
    redirect("/profile");
  }
  const next = nextStep(completed);
  redirect(next === "done" ? "/profile" : `/welcome?step=${next}`);
}

/** 30 змін джерел на годину: цього досить людині й мало, щоб перебирати чужі адреси. */
const IDENTITY_LIMITS: Limits = { windowMinutes: 60, maxAttempts: 30, blockMinutes: 60 };

/** Повідомлення, якщо людина змінює джерела занадто часто, інакше null. */
export async function identityWriteGuard(ctx: StepContext): Promise<FormMessage | null> {
  const verdict = await consume(`identity:${ctx.user.id}`, IDENTITY_LIMITS, ctx.d);
  if (verdict.allowed) return null;
  const n = verdict.retryAfterMinutes;
  return { tone: "error", text: `Too many changes. Try again in ${n === 1 ? "1 minute" : `${n} minutes`}.` };
}

export const GENERIC_ERROR: FormMessage = { tone: "error", text: "Something went wrong. Try again." };

/** Текст поля форми або порожній рядок. */
export function field(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
}
