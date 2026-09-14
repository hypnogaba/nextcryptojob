"use server";

import { normalizeX } from "@/lib/identity/normalize";
import { getIdentity, setSingleIdentity } from "@/lib/identity/store";
import { saveStep } from "@/lib/onboarding/store";
import { field, goNext, identityWriteGuard, recordChange, stepContext, type StepState } from "../flow";

// Крок X: обов'язковий, одразу після анкети. Людина вписує нік, ми йому віримо (модель довіри
// 13.09, docs/DECISIONS.md): без коду в біо й без входу через X. Той самий нік в іншому профілі
// теж не заважає (раунд 3 власника, 14.09: «жодної перевірки»). Далі без ніка не пускаємо.

export async function saveXAction(_prev: StepState, form: FormData): Promise<StepState> {
  const ctx = await stepContext("x");
  const raw = field(form, "handle");
  const handle = normalizeX(raw);
  if (!handle.ok) return { errors: { handle: handle.error }, values: { handle: raw } };

  const before = await getIdentity(ctx.d, ctx.user.id, "x");
  if (before?.value !== handle.value) {
    const limited = await identityWriteGuard(ctx);
    if (limited) return { message: limited, values: { handle: raw } };
    await setSingleIdentity(ctx.d, ctx.user.id, "x", handle.value);
    await recordChange(ctx, "x");
  }
  await saveStep(ctx.d, ctx.user.id, "x", {}, ctx.answers.step);
  return goNext(ctx, "x");
}
