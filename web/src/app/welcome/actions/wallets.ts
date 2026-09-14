"use server";

import { setWallets } from "@/lib/identity/store";
import { parseWallets } from "@/lib/identity/wallets";
import { saveStep } from "@/lib/onboarding/store";
import { field, goNext, identityWriteGuard, recordChange, stepContext, type StepState } from "../flow";

// Крок гаманців: одне поле, багато адрес. Помилка кожної адреси окремо.

export async function saveWalletsAction(_prev: StepState, form: FormData): Promise<StepState> {
  const ctx = await stepContext("wallets");
  const text = field(form, "wallets");
  const values = { wallets: text };
  const { wallets, errors } = parseWallets(text);
  if (errors.length > 0) {
    return { errors: Object.fromEntries(errors.map((e) => [e.input, e.error])), values };
  }
  const limited = await identityWriteGuard(ctx);
  if (limited) return { message: limited, values };

  // Адреса, яку вписав і хтось інший, не заважає (0022, раунд 3 власника).
  const res = await setWallets(ctx.d, ctx.user.id, wallets);
  await saveStep(ctx.d, ctx.user.id, "wallets", {}, ctx.answers.step);
  if (res.added + res.removed > 0) await recordChange(ctx, "wallets");
  return goNext(ctx, "wallets");
}

/** «Skip for now»: гаманці не обов'язкові, добірка без них працює. Адрес не чіпає. */
export async function skipWalletsAction(): Promise<void> {
  const ctx = await stepContext("wallets");
  await saveStep(ctx.d, ctx.user.id, "wallets", {}, ctx.answers.step);
  await goNext(ctx, "wallets");
}
