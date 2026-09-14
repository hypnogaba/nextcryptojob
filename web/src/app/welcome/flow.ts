import { redirect } from "next/navigation";
import type { FormMessage } from "@/components/form/form-message";
import { consume, type Limits } from "@/lib/auth/ratelimit";
import { requireUser, type SessionUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { loadAnswers, type Answers } from "@/lib/onboarding/store";
import { briefDone, canVisit, isBriefStep, nextStep, type Step } from "@/lib/onboarding/steps";
import { markSourcesChanged, type ChangeKind } from "@/lib/score/changes";
import { enqueueScoreJob } from "@/lib/score/queue";
import { profileStatus } from "@/lib/score/status";

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

/**
 * wasDone: пройдено все, і «Stand out» теж (крок відкрито як редагування з профілю).
 * briefDone: анкету пройдено й згоду дано; зміна джерел одразу ставить бал у чергу.
 */
export type StepContext = { user: SessionUser; d: D1Database; answers: Answers; wasDone: boolean; briefDone: boolean };

/**
 * Людина, база й відповіді для дії кроку. Дію можна викликати й запитом
 * в обхід сторінки, тож крок, до якого людина ще не дійшла, відсилає назад.
 */
export async function stepContext(step: Step): Promise<StepContext> {
  const user = await requireUser();
  const d = db();
  const answers = await loadAnswers(d, user.id);
  if (!canVisit(step, answers.step)) redirect("/welcome");
  return { user, d, answers, wasDone: answers.step === "done", briefDone: briefDone(answers.step) };
}

/** Ставить бал у чергу; секунди до наступної спроби, якщо «зарано», інакше null. */
async function rescoreNow(ctx: StepContext): Promise<number | null> {
  const res = await enqueueScoreJob(ctx.d, ctx.user.id, "connect");
  return !res.ok && res.reason === "too_soon" ? res.retryAfterSeconds : null;
}

/**
 * Записує зміну джерел чи ролей. Якщо анкету вже пройдено (згода є), одразу пробує
 * поставити бал у чергу й повертає, скільки секунд чекати, якщо зарано.
 * Навіть тоді перерахунок не губиться: профіль бачить мітку зміни й пропонує
 * «Update my score».
 */
export async function recordChange(ctx: StepContext, what: ChangeKind): Promise<number | null> {
  await markSourcesChanged(ctx.d, ctx.user.id, what);
  return ctx.briefDone ? rescoreNow(ctx) : null;
}

/** Додає ?wait=N (скільки секунд до перерахунку), якщо є що чекати. */
export function withWait(url: string, wait: number | null): string {
  return wait ? `${url}${url.includes("?") ? "&" : "?"}wait=${wait}` : url;
}

/**
 * Після збереження кроку.
 * - Анкета: на наступний крок; якщо її вже пройдено, на /jobs, де видно нові вакансії.
 *   Слова й ролі йдуть парою: після слів завжди крок ролей.
 * - Кроки балу (X, гаманці, джерела): на наступний крок; після останнього в першому проході
 *   на /welcome/score, яка ставить бал у чергу й чекає на нього; при редагуванні з профілю
 *   у профіль, і якщо після останнього перерахунку щось змінилось, бал іде в чергу.
 */
export async function goNext(ctx: StepContext, completed: Step): Promise<never> {
  const next = nextStep(completed);
  if (isBriefStep(completed)) {
    redirect(ctx.briefDone && completed !== "target" ? "/jobs" : `/welcome?step=${next}`);
  }
  if (!ctx.wasDone && next === "done") redirect(SCORE_PATH);
  if (ctx.wasDone) {
    const status = await profileStatus(ctx.d, ctx.user.id);
    redirect(withWait("/profile", status.sourcesChanged ? await rescoreNow(ctx) : null));
  }
  redirect(`/welcome?step=${next}`);
}

/** Сторінка «Scoring your work…» і результату одразу після кроків балу. */
export const SCORE_PATH = "/welcome/score";

/** Секунди очікування з адреси (?wait=), лише розумне ціле. */
export function parseWait(raw: unknown): number | null {
  const n = typeof raw === "string" ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 && n <= 3600 ? n : null;
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
