"use server";

import { setWallets } from "@/lib/identity/store";
import { parseWallets } from "@/lib/identity/wallets";
import { saveStep } from "@/lib/onboarding/store";
import { field, goNext, identityWriteGuard, recordChange, stepContext, type StepState } from "../flow";

// Крок гаманців: одне поле, багато адрес. Помилка кожної адреси окремо.
// Гаманець обов'язковий, як X (власник 15.09, п.5): при першому проході (wasDone === false)
// без жодної адреси далі не пускаємо, на сервері, а не лише кнопкою в WalletsForm. Хто вже
// пройшов усе раніше (редагування з профілю), може лишити поле порожнім: не блокуємо існуючих.

export async function saveWalletsAction(_prev: StepState, form: FormData): Promise<StepState> {
  const ctx = await stepContext("wallets");
  const text = field(form, "wallets");
  const values = { wallets: text };
  const { wallets, errors } = parseWallets(text);
  if (errors.length > 0) {
    return { errors: Object.fromEntries(errors.map((e) => [e.input, e.error])), values };
  }
  if (!ctx.wasDone && wallets.length === 0) {
    return { message: { tone: "error", text: "Add at least one EVM or Solana address to continue." }, values };
  }
  const limited = await identityWriteGuard(ctx);
  if (limited) return { message: limited, values };

  // Адреса, яку вписав і хтось інший, не заважає (0022, раунд 3 власника).
  const res = await setWallets(ctx.d, ctx.user.id, wallets);
  await saveStep(ctx.d, ctx.user.id, "wallets", {}, ctx.answers.step);
  if (res.added + res.removed > 0) await recordChange(ctx, "wallets");
  return goNext(ctx, "wallets");
}
