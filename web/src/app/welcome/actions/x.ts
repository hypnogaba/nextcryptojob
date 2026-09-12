"use server";

import { redirect } from "next/navigation";
import { normalizeX } from "@/lib/identity/normalize";
import { removeIdentities, setSingleIdentity } from "@/lib/identity/store";
import { saveStep } from "@/lib/onboarding/store";
import { newVerifyCode } from "@/lib/verify/code";
import { field, goNext, identityWriteGuard, stepContext, type StepState } from "../flow";

// Крок X: нік → код → перевірка (actions/verify.ts) або «пропустити».

export async function claimXAction(_prev: StepState, form: FormData): Promise<StepState> {
  const ctx = await stepContext("x");
  const raw = field(form, "handle");
  const handle = normalizeX(raw);
  if (!handle.ok) return { errors: { handle: handle.error }, values: { handle: raw } };
  const limited = await identityWriteGuard(ctx);
  if (limited) return { message: limited, values: { handle: raw } };

  const res = await setSingleIdentity(ctx.d, ctx.user.id, "x", handle.value, newVerifyCode());
  if (!res.ok) {
    const text =
      res.reason === "pending"
        ? "Another profile started linking this X account. If it is yours, try again in 24 hours."
        : "This X account is already linked to another profile.";
    return { errors: { handle: text }, values: { handle: raw } };
  }
  redirect("/welcome?step=x");
}

/** «Use a different handle»: прибирає нік (і позначку перевірки) цієї людини. */
export async function resetXAction(): Promise<void> {
  const ctx = await stepContext("x");
  await removeIdentities(ctx.d, ctx.user.id, "x");
  redirect("/welcome?step=x");
}

/** «Continue» після перевірки або «Skip for now»: X не обов'язковий. */
export async function continueXAction(): Promise<void> {
  const ctx = await stepContext("x");
  await saveStep(ctx.d, ctx.user.id, "x", {}, ctx.answers.step);
  await goNext(ctx, "x", true);
}
