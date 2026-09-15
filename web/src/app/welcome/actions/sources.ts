"use server";

import { NORMALIZERS } from "@/lib/identity/normalize";
import { listIdentities, removeIdentities, setSingleIdentity, type SingleKind } from "@/lib/identity/store";
import { saveStep } from "@/lib/onboarding/store";
import { field, goNext, identityWriteGuard, recordChange, stepContext, type StepState } from "../flow";

// «More sources»: GitHub, YouTube, сайт. Кожне поле необов'язкове; порожнє поле прибирає джерело.
// Свої джерела не перевіряємо (модель довіри 13.09), і той самий нік в іншому профілі не заважає
// (раунд 3 власника, 14.09). Sherlock з анкети прибрано (власник 13.09):
// наявний рядок sherlock не чіпаємо, рушій звіряє його лише з підтвердженими GitHub або X.

const FIELDS = ["github", "youtube", "site"] as const satisfies readonly SingleKind[];
type Field = (typeof FIELDS)[number];

export async function saveSourcesAction(_prev: StepState, form: FormData): Promise<StepState> {
  const ctx = await stepContext("sources");
  const values = Object.fromEntries(FIELDS.map((k) => [k, field(form, k).trim()])) as Record<Field, string>;

  const errors: Record<string, string> = {};
  const normalized: Partial<Record<Field, string | null>> = {};
  for (const kind of FIELDS) {
    if (!values[kind]) {
      normalized[kind] = null;
      continue;
    }
    const res = NORMALIZERS[kind](values[kind]);
    if (res.ok) normalized[kind] = res.value;
    else errors[kind] = res.error;
  }
  if (Object.keys(errors).length > 0) return { errors, values };

  const before = new Map((await listIdentities(ctx.d, ctx.user.id)).map((i) => [i.kind, i.value]));
  const changed = FIELDS.filter((k) => (before.get(k) ?? null) !== normalized[k]);
  if (changed.length > 0) {
    const limited = await identityWriteGuard(ctx);
    if (limited) return { message: limited, values };
  }
  for (const kind of changed) {
    const value = normalized[kind];
    if (value === null || value === undefined) await removeIdentities(ctx.d, ctx.user.id, kind);
    else await setSingleIdentity(ctx.d, ctx.user.id, kind, value);
  }
  if (changed.length > 0) await recordChange(ctx, "sources");

  await saveStep(ctx.d, ctx.user.id, "sources", {}, ctx.answers.step);
  return goNext(ctx, "sources");
}

/** «Skip for now»: джерела необов'язкові, далі бал. Нічого не зберігає й не прибирає. */
export async function continueSourcesAction(): Promise<void> {
  const ctx = await stepContext("sources");
  await saveStep(ctx.d, ctx.user.id, "sources", {}, ctx.answers.step);
  await goNext(ctx, "sources");
}
