"use server";

import { redirect } from "next/navigation";
import { normalizeX } from "@/lib/identity/normalize";
import { getIdentity, removeIdentities, setSingleIdentity } from "@/lib/identity/store";
import { saveStep } from "@/lib/onboarding/store";
import { newVerifyCode } from "@/lib/verify/code";
import {
  field,
  goNext,
  identityWriteGuard,
  recordChange,
  stepContext,
  withWait,
  type StepState,
} from "../flow";

// Крок X: нік → код → перевірка (actions/verify.ts) або «пропустити».

export async function claimXAction(_prev: StepState, form: FormData): Promise<StepState> {
  const ctx = await stepContext("x");
  const raw = field(form, "handle");
  const handle = normalizeX(raw);
  if (!handle.ok) return { errors: { handle: handle.error }, values: { handle: raw } };
  const limited = await identityWriteGuard(ctx);
  if (limited) return { message: limited, values: { handle: raw } };

  const before = await getIdentity(ctx.d, ctx.user.id, "x");
  const res = await setSingleIdentity(ctx.d, ctx.user.id, "x", handle.value, newVerifyCode());
  if (!res.ok) {
    // Нік чекає підтвердження в іншому профілі: власник доведе своє кодом заявки.
    if (res.reason === "pending") redirect(`/welcome?step=x&claim=${encodeURIComponent(handle.value)}`);
    return { errors: { handle: "This X account is already linked to another profile." }, values: { handle: raw } };
  }
  const wait = before?.value !== handle.value ? await recordChange(ctx, "x") : null;
  redirect(withWait("/welcome?step=x", wait));
}

/** «Use a different handle»: прибирає нік (і позначку перевірки) цієї людини. */
export async function resetXAction(): Promise<void> {
  const ctx = await stepContext("x");
  const before = await getIdentity(ctx.d, ctx.user.id, "x");
  await removeIdentities(ctx.d, ctx.user.id, "x");
  const wait = before ? await recordChange(ctx, "x") : null;
  redirect(withWait("/welcome?step=x", wait));
}

/** «Continue» після перевірки або «Skip for now»: X не обов'язковий. */
export async function continueXAction(): Promise<void> {
  const ctx = await stepContext("x");
  await saveStep(ctx.d, ctx.user.id, "x", {}, ctx.answers.step);
  await goNext(ctx, "x");
}
