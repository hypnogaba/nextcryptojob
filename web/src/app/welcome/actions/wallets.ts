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

  const res = await setWallets(ctx.d, ctx.user.id, wallets);
  if (!res.ok) {
    if (res.taken.length === 0) {
      return {
        message: { tone: "error", text: "One of these addresses was just linked to another profile. Try again." },
        values,
      };
    }
    // Помилку показуємо проти адреси так, як людина її вставила (EVM у будь-якому регістрі).
    const taken = new Set(res.taken.map((w) => `${w.kind}:${w.value}`));
    const byInput: Record<string, string> = {};
    for (const token of text.split(/[\s,;]+/).filter(Boolean)) {
      const key = /^0x/i.test(token) ? `evm:${token.toLowerCase()}` : `solana:${token}`;
      if (taken.has(key)) byInput[token] = "This address is already linked to another profile.";
    }
    return { errors: byInput, values };
  }
  await saveStep(ctx.d, ctx.user.id, "wallets", {}, ctx.answers.step);
  if (res.added + res.removed > 0) await recordChange(ctx, "wallets");
  return goNext(ctx, "wallets");
}
