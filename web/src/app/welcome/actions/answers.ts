"use server";

import { isRoleKey, type RoleKey } from "@/lib/card/roles";
import { parsePlace } from "@/lib/onboarding/place";
import { placeFields, rolesFields, saveStep, TARGET_MAX, targetFields } from "@/lib/onboarding/store";
import { MAX_ROLES } from "@/lib/roles/catalog";
import { field, goNext, recordChange, stepContext, type StepState } from "../flow";

// Кроки про намір: що шукає людина, які ролі, де працювати.

export async function saveTargetAction(_prev: StepState, form: FormData): Promise<StepState> {
  const ctx = await stepContext("target");
  const text = field(form, "target").trim().replace(/\s+/g, " ");
  if (text.length < 2) {
    return { errors: { target: "Tell us in a few words what job you want." }, values: { target: text } };
  }
  if (text.length > TARGET_MAX) {
    return { errors: { target: `Keep it under ${TARGET_MAX} characters.` }, values: { target: text } };
  }
  await saveStep(ctx.d, ctx.user.id, "target", targetFields(text), ctx.answers.step);
  // Слова й ролі йдуть парою: і після анкети далі крок ролей (goNext).
  return goNext(ctx, "target");
}

export async function saveRolesAction(_prev: StepState, form: FormData): Promise<StepState> {
  const ctx = await stepContext("roles");
  const roles = [...new Set(form.getAll("role").map(String))].filter(isRoleKey) as RoleKey[];
  if (roles.length === 0) return { errors: { role: "Pick at least one role." } };
  if (roles.length > MAX_ROLES) return { errors: { role: `Pick up to ${MAX_ROLES} roles.` } };
  const changed = JSON.stringify(roles) !== JSON.stringify(ctx.answers.roles);
  await saveStep(ctx.d, ctx.user.id, "roles", rolesFields(roles), ctx.answers.step);
  if (changed) await recordChange(ctx, "roles");
  return goNext(ctx, "roles");
}

export async function savePlaceAction(_prev: StepState, form: FormData): Promise<StepState> {
  const ctx = await stepContext("place");
  const values = {
    where: field(form, "where"),
    city: field(form, "city"),
    salary: field(form, "salary"),
    currency: field(form, "currency"),
  };
  const parsed = parsePlace(values);
  if (!parsed.ok) return { errors: parsed.errors, values };
  await saveStep(ctx.d, ctx.user.id, "place", placeFields(parsed.place), ctx.answers.step);
  // Місце й зарплата на бал не впливають, лише на вибір вакансій.
  return goNext(ctx, "place");
}
