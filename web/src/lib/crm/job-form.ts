import { isRoleKey } from "@/lib/card/roles";
import type { Job } from "./jobs";
import type { RoleKey } from "./types";

/**
 * Форма вакансії на /company/jobs/new і /company/jobs/<id> (специфікація 10.2): поля
 * форми → вхід post_job / update_job реєстру дій і назад (значення для повторного
 * показу після помилки). Перевірку полів робить реєстр (lib/crm/jobs.ts), тут лише
 * розбір форми: числа зарплати й теги через кому.
 */

export const SALARY_CURRENCIES = ["USD", "EUR", "GBP", "CHF", "CAD", "AUD", "SGD", "AED"] as const;

/** Значення полів форми, як їх показати (рядки й вибрані пункти). */
export interface JobFormValues {
  title: string;
  roles: string[];
  work_mode: string[];
  city: string;
  country: string;
  salary_min: string;
  salary_max: string;
  salary_currency: string;
  salary_period: string;
  apply_url: string;
  description: string;
  tags: string;
  post_on_x: boolean;
}

export const EMPTY_JOB_FORM: JobFormValues = {
  title: "",
  roles: [],
  work_mode: ["remote"],
  city: "",
  country: "",
  salary_min: "",
  salary_max: "",
  salary_currency: "USD",
  salary_period: "year",
  apply_url: "",
  description: "",
  tags: "",
  post_on_x: false,
};

export function formValuesOf(job: Job): JobFormValues {
  return {
    title: job.title,
    roles: [...job.roles],
    work_mode: [...job.work_mode],
    city: job.city ?? "",
    country: job.country ?? "",
    salary_min: job.salary?.min != null ? String(job.salary.min) : "",
    salary_max: job.salary?.max != null ? String(job.salary.max) : "",
    salary_currency: job.salary?.currency ?? "USD",
    salary_period: job.salary?.period ?? "year",
    apply_url: job.apply_url ?? "",
    description: job.description ?? "",
    tags: (job.tags ?? []).join(", "),
    post_on_x: job.x_post.state === "queued" || job.x_post.state === "posted",
  };
}

const text = (form: FormData, name: string, max: number) => String(form.get(name) ?? "").slice(0, max);

export function readJobForm(form: FormData): JobFormValues {
  return {
    title: text(form, "title", 200),
    roles: form.getAll("roles").map(String).filter(isRoleKey).slice(0, 15),
    work_mode: form
      .getAll("work_mode")
      .map(String)
      .filter((m) => m === "remote" || m === "city"),
    city: text(form, "city", 200),
    country: text(form, "country", 2),
    salary_min: text(form, "salary_min", 20),
    salary_max: text(form, "salary_max", 20),
    salary_currency: text(form, "salary_currency", 3),
    salary_period: form.get("salary_period") === "month" ? "month" : "year",
    apply_url: text(form, "apply_url", 1200),
    description: text(form, "description", 6000),
    tags: text(form, "tags", 600),
    post_on_x: form.get("post_on_x") === "on",
  };
}

/** Сума з поля: «120,000» чи «120 000» теж; порожнє = null; не ціле число = помилка. */
function amount(raw: string): number | null | "bad" {
  const v = raw.replace(/[\s,_']/g, "");
  if (!v) return null;
  if (!/^\d{1,9}$/.test(v)) return "bad";
  return Number(v);
}

export interface JobFormInput {
  title: string;
  roles: RoleKey[];
  work_mode: ("remote" | "city")[];
  city: string | null;
  country: string | null;
  salary: { min: number | null; max: number | null; currency: string; period: "year" | "month" } | null;
  apply_url: string | null;
  description: string;
  tags: string[];
  post_on_x: boolean;
}

/**
 * Вхід для реєстру або помилки полів. Межі, які схема реєстру ловить раніше за свої
 * тексти (кількість ролей, довжини), перевіряємо тут тими самими словами, що в
 * lib/crm/jobs.ts: людина бачить "Choose 1 to 3 roles.", а не текст схеми.
 */
export function jobInputOf(v: JobFormValues): { input: JobFormInput } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const title = v.title.replace(/\s+/g, " ").trim();
  if (title.length < 3 || title.length > 120) errors.title = "Use 3 to 120 characters.";
  const roles = [...new Set(v.roles.filter(isRoleKey))];
  if (roles.length < 1 || roles.length > 3) errors.roles = "Choose 1 to 3 roles.";
  const workMode = v.work_mode.filter((m): m is "remote" | "city" => m === "remote" || m === "city");
  if (workMode.length === 0) errors.work_mode = "Choose Remote, City or both.";
  const city = v.city.trim();
  if (city.length > 80) errors.city = "Use up to 80 characters.";
  if (v.description.length > 5000) errors.description = "Use up to 5000 characters.";
  const tags = v.tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (tags.length > 10 || tags.some((t) => t.length > 32)) errors.tags = "Use up to 10 tags of up to 32 characters each.";
  const min = amount(v.salary_min);
  const max = amount(v.salary_max);
  if (min === "bad" || max === "bad") errors.salary = "Use whole numbers, for example 120000.";
  if (Object.keys(errors).length > 0 || min === "bad" || max === "bad") return { errors };

  const currency = (SALARY_CURRENCIES as readonly string[]).includes(v.salary_currency) ? v.salary_currency : "USD";
  return {
    input: {
      title,
      roles,
      work_mode: workMode,
      city: city || null,
      country: v.country.trim() || null,
      salary: min === null && max === null ? null : { min, max, currency, period: v.salary_period === "month" ? "month" : "year" },
      apply_url: v.apply_url.trim() || null,
      description: v.description,
      tags,
      post_on_x: v.post_on_x,
    },
  };
}

/** Помилки реєстру (`details.fields`, шлях поля) → назви полів форми. */
export function formFieldErrors(fields: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, message] of Object.entries(fields ?? {})) {
    const key = path.split(".")[0] ?? path;
    out[key] ??= message;
  }
  return out;
}
