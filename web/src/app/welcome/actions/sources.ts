"use server";

import { redirect } from "next/navigation";
import { NORMALIZERS } from "@/lib/identity/normalize";
import { listIdentities, removeIdentities, setSingleIdentity, type SingleKind } from "@/lib/identity/store";
import { saveStep } from "@/lib/onboarding/store";
import { newVerifyCode } from "@/lib/verify/code";
import { field, goNext, identityWriteGuard, stepContext, type StepState } from "../flow";

// «More sources»: GitHub, YouTube, сайт, Sherlock. Кожне поле необов'язкове;
// порожнє поле прибирає джерело.

const FIELDS = ["github", "youtube", "site", "sherlock"] as const satisfies readonly SingleKind[];

const TAKEN: Record<(typeof FIELDS)[number], string> = {
  github: "This GitHub account is already linked to another profile.",
  youtube: "This YouTube channel is already linked to another profile.",
  site: "This website is already linked to another profile.",
  sherlock: "This Sherlock profile is already linked to another profile.",
};

export async function saveSourcesAction(_prev: StepState, form: FormData): Promise<StepState> {
  const ctx = await stepContext("sources");
  const values = Object.fromEntries(FIELDS.map((k) => [k, field(form, k).trim()])) as Record<
    (typeof FIELDS)[number],
    string
  >;

  const errors: Record<string, string> = {};
  const normalized: Partial<Record<(typeof FIELDS)[number], string | null>> = {};
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
    if (value === null || value === undefined) {
      await removeIdentities(ctx.d, ctx.user.id, kind);
      continue;
    }
    // GitHub можна підтвердити кодом у біо, тож код одразу.
    const res = await setSingleIdentity(ctx.d, ctx.user.id, kind, value, kind === "github" ? newVerifyCode() : null);
    if (!res.ok) errors[kind] = TAKEN[kind];
  }
  if (Object.keys(errors).length > 0) return { errors, values };

  await saveStep(ctx.d, ctx.user.id, "sources", {}, ctx.answers.step);
  // Щойно доданий GitHub: лишаємось на кроці, щоб людина побачила, як його підтвердити.
  if (changed.includes("github") && normalized.github) redirect("/welcome?step=sources&added=github");
  return goNext(ctx, "sources", changed.length > 0);
}

/** «Continue» з панелі підтвердження GitHub. */
export async function continueSourcesAction(): Promise<void> {
  const ctx = await stepContext("sources");
  await saveStep(ctx.d, ctx.user.id, "sources", {}, ctx.answers.step);
  await goNext(ctx, "sources", true);
}
