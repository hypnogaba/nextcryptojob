// Відповіді анкети в users: що шукає людина, ролі, місце, зарплата і
// досягнутий крок. Кожне збереження кроку й перехід далі одним записом.
import type { RoleKey } from "@/lib/card/roles";
import { parseRoles } from "@/lib/roles/catalog";
import type { Place } from "./place";
import { advance, normalizeSavedStep, parseSavedStep, type SavedStep, type Step } from "./steps";

export const TARGET_MAX = 600;
/** «My role is not in the list»: коротка назва ролі своїми словами. */
export const ROLE_TEXT_MAX = 80;

export type Answers = {
  targetText: string;
  roles: RoleKey[];
  /** Своя роль словами (users.role_text) або порожньо. */
  roleText: string;
  remoteMode: string | null;
  city: string | null;
  salaryMin: number | null;
  salaryCurrency: string | null;
  step: SavedStep;
};

type UserRow = {
  target_text: string | null;
  roles: string | null;
  role_text: string | null;
  remote_mode: string | null;
  city: string | null;
  salary_min: number | null;
  salary_currency: string | null;
  onboarding_step: string | null;
  scoring: number | null;
};

export async function loadAnswers(db: D1Database, userId: string): Promise<Answers> {
  const row = await db
    .prepare(
      `SELECT target_text, roles, role_text, remote_mode, city, salary_min, salary_currency, onboarding_step,
              (SELECT granted FROM consents WHERE user_id = users.id AND kind = 'scoring') AS scoring
         FROM users WHERE id = ?`,
    )
    .bind(userId)
    .first<UserRow>();
  return {
    targetText: row?.target_text ?? "",
    roles: parseRoles(row?.roles),
    roleText: row?.role_text ?? "",
    remoteMode: row?.remote_mode ?? null,
    city: row?.city ?? null,
    salaryMin: row?.salary_min ?? null,
    salaryCurrency: row?.salary_currency ?? null,
    // Згода в тому самому читанні: крок «Stand out» без згоди (старий порядок) = ще анкета.
    step: normalizeSavedStep(parseSavedStep(row?.onboarding_step), row?.scoring === 1),
  };
}

/** Поля, які можна змінити з анкети. Назви стовпців лише звідси, не з форми. */
type Fields = {
  target_text?: string;
  roles?: string;
  role_text?: string | null;
  remote_mode?: string;
  city?: string | null;
  salary_min?: number | null;
  salary_currency?: string | null;
};

/**
 * Зберігає відповіді кроку `completed` і просуває досягнутий крок уперед.
 * Повертає новий досягнутий крок.
 */
export async function saveStep(
  db: D1Database,
  userId: string,
  completed: Step,
  fields: Fields,
  saved: SavedStep,
): Promise<SavedStep> {
  const step = advance(saved, completed);
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  const sets = [...entries.map(([k]) => `${k} = ?`), "onboarding_step = ?"].join(", ");
  await db
    .prepare(`UPDATE users SET ${sets} WHERE id = ?`)
    .bind(...entries.map(([, v]) => v), step, userId)
    .run();
  return step;
}

export function targetFields(text: string): Fields {
  return { target_text: text };
}

export function rolesFields(roles: RoleKey[], roleText: string | null = null): Fields {
  return { roles: JSON.stringify(roles), role_text: roleText };
}

export function placeFields(place: Place): Fields {
  return {
    remote_mode: place.remoteMode,
    city: place.city,
    salary_min: place.salaryMin,
    salary_currency: place.salaryCurrency,
  };
}

/** Усе пройдено (і «Stand out»): далі /welcome показує кроки як редагування. */
export async function finishOnboarding(db: D1Database, userId: string): Promise<void> {
  await db.prepare("UPDATE users SET onboarding_step = 'done' WHERE id = ?").bind(userId).run();
}
