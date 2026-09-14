"use server";

import { redirect } from "next/navigation";
import { NORMALIZERS } from "@/lib/identity/normalize";
import { listIdentities, removeIdentities, setSingleIdentity, type SingleKind } from "@/lib/identity/store";
import { saveStep } from "@/lib/onboarding/store";
import { field, goNext, identityWriteGuard, recordChange, stepContext, withWait, type StepState } from "../flow";

// «More sources»: GitHub, YouTube, сайт. Кожне поле необов'язкове; порожнє поле прибирає джерело.
// Свої джерела не перевіряємо (модель довіри 13.09). Sherlock з анкети прибрано (власник 13.09):
// наявний рядок sherlock не чіпаємо, рушій звіряє його лише з підтвердженими GitHub або X.

const FIELDS = ["github", "youtube", "site"] as const satisfies readonly SingleKind[];
type Field = (typeof FIELDS)[number];

const TAKEN: Record<Field, string> = {
  github: "This GitHub account is already linked to another profile.",
  youtube: "This YouTube channel is already linked to another profile.",
  site: "This website is already linked to another profile.",
};

const GITHUB_PENDING =
  "This GitHub account is already linked to another profile. Fix the other fields and save again to prove it is yours.";

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
  let githubPending = false;
  const saved: Field[] = [];
  for (const kind of changed) {
    const value = normalized[kind];
    if (value === null || value === undefined) {
      await removeIdentities(ctx.d, ctx.user.id, kind);
      saved.push(kind);
      continue;
    }
    const res = await setSingleIdentity(ctx.d, ctx.user.id, kind, value);
    if (res.ok) saved.push(kind);
    else if (kind === "github" && res.reason === "pending") githubPending = true;
    else errors[kind] = TAKEN[kind];
  }
  const wait = saved.length > 0 ? await recordChange(ctx, "sources") : null;
  if (Object.keys(errors).length > 0) {
    if (githubPending) errors.github = GITHUB_PENDING;
    return { errors, values };
  }

  await saveStep(ctx.d, ctx.user.id, "sources", {}, ctx.answers.step);
  // GitHub в іншого профілю без підтвердження: показуємо код заявки (спір за нік).
  if (githubPending) redirect(withWait(`/welcome?step=sources&claim=${encodeURIComponent(normalized.github!)}`, wait));
  return goNext(ctx, "sources");
}

/** «Skip for now»: джерела необов'язкові, далі бал. Нічого не зберігає й не прибирає. */
export async function continueSourcesAction(): Promise<void> {
  const ctx = await stepContext("sources");
  await saveStep(ctx.d, ctx.user.id, "sources", {}, ctx.answers.step);
  await goNext(ctx, "sources");
}
