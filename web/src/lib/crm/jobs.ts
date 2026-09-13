import type { z } from "zod";
import { isRoleKey } from "@/lib/card/roles";
import { formatSalary, plausibleSalary } from "@/lib/digest/format";
import { newId } from "@/lib/ids";
import { siteOrigin } from "@/lib/site";
import { isoTime, sqlTime } from "@/lib/time";
import type { ActionContext, CompanyInfo } from "./context";
import { countryCode } from "./countries";
import { normalizeTags } from "./pipeline";
import { SEATS } from "./quotas";
import { ActionError, type Job as JobSchema, type JobList as JobListSchema, type RoleKey } from "./types";

/**
 * Вакансії компаній (специфікація CRM 5.6, 10.2): list_jobs, post_job, get_job,
 * update_job, close_job реєстру дій. Кожен запит фільтрує company_id актора:
 * чужий id дає 404, як і неіснуючий.
 *
 * Стани: draft → open → closed. Відкрита вимагає apply_url (https:// або mailto:) і
 * живе 60 днів (expires_at); "Publish" закритої чи простроченої відкриває її знову
 * на 60 днів. Назад у чернетку вакансія не йде: її закривають. Відкритих не більше
 * за план (розділ 9: 10, у пробному 2); межа стоїть у самому INSERT/UPDATE, тож дві
 * паралельні спроби її не перевищать. Вакансії публікуються одразу (DECISIONS 12.09),
 * адмін може сховати (hidden_by_admin_at, lib/admin/jobs.ts).
 *
 * «Жива» = рядок у поданні company_jobs_live (0012): відкрита, не прихована, не
 * прострочена, компанія з підпискою. Лише жива йде в добірки, у search_jobs і на
 * публічну сторінку /jobs/<id>.
 *
 * X: "Post on @nextcryptojob" ставить x_post_state = 'queued' і текст за шаблоном
 * (до 280 символів), адмін публікує вручну (/admin/x-queue). Черга показує лише живі,
 * тож галочка на чернетці чекає публікації. Закриття знімає з черги ('skipped').
 */

export type Job = z.infer<typeof JobSchema>;
export type JobList = z.infer<typeof JobListSchema>;
type WorkMode = "remote" | "city";
type Salary = { min: number | null; max: number | null; currency: string; period: "year" | "month" };

export const JOB_LIFETIME_DAYS = 60;
export const X_POST_MAX = 280;
export const APPLY_URL_MAX = 1000;
const DEFAULT_LIMIT = 20;
const DAY_MS = 86_400_000;

type CompanyCtx = ActionContext & { company: CompanyInfo };

function companyCtx(ctx: ActionContext): { ctx: CompanyCtx; userId: string | null; keyId: string | null } {
  if (!ctx.company) throw new ActionError("unauthorized", 401, "Sign in or send an API key.");
  if (ctx.actor.kind === "member") return { ctx: ctx as CompanyCtx, userId: ctx.actor.userId, keyId: null };
  if (ctx.actor.kind === "agent") return { ctx: ctx as CompanyCtx, userId: null, keyId: ctx.actor.keyId };
  throw new ActionError("forbidden", 403, "Only company members and agents can manage jobs.");
}

/** Скільки відкритих вакансій дозволяє план (розділ 9); без підписки 0. */
export function openJobLimit(company: Pick<CompanyInfo, "plan">): number {
  if (company.plan === "trial") return SEATS.trial.openJobs;
  if (company.plan === "subscription") return SEATS.subscription.openJobs;
  return 0;
}

function openLimitError(company: Pick<CompanyInfo, "plan">): ActionError {
  const limit = openJobLimit(company);
  return new ActionError(
    "quota_exceeded",
    403,
    company.plan === "trial"
      ? `Your trial allows ${limit} open jobs. Close one or subscribe for up to ${SEATS.subscription.openJobs}.`
      : `You can keep up to ${limit} open jobs. Close one first.`,
    { limit },
  );
}

const notFound = () => new ActionError("not_found", 404, "This job was not found.");

function fieldsError(fields: Record<string, string>): ActionError {
  return new ActionError("validation_failed", 422, "Some fields are not valid.", { fields });
}

// ---------------------------------------------------------------------------
// Рядки

interface Row {
  id: string;
  company_id: string;
  status: "draft" | "open" | "closed";
  title: string;
  description: string;
  roles: string;
  remote_mode: string;
  city: string | null;
  country: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  salary_period: "year" | "month" | null;
  apply_url: string | null;
  tags: string;
  x_post_state: "none" | "queued" | "posted" | "skipped";
  x_post_text: string | null;
  x_post_url: string | null;
  x_queued_at: string | null;
  digest_shown: number;
  apply_clicks: number;
  hidden_by_admin_at: string | null;
  published_at: string | null;
  expires_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  live: number;
}

const COLUMNS = `j.id, j.company_id, j.status, j.title, j.description, j.roles, j.remote_mode, j.city, j.country,
  j.salary_min, j.salary_max, j.salary_currency, j.salary_period, j.apply_url, j.tags, j.x_post_state, j.x_post_text,
  j.x_post_url, j.x_queued_at, j.digest_shown, j.apply_clicks, j.hidden_by_admin_at, j.published_at, j.expires_at,
  j.closed_at, j.created_at, j.updated_at,
  EXISTS (SELECT 1 FROM company_jobs_live l WHERE l.id = j.id) AS live`;

async function rowOf(db: D1Database, companyId: string, id: string): Promise<Row | null> {
  return db.prepare(`SELECT ${COLUMNS} FROM company_jobs j WHERE j.id = ? AND j.company_id = ?`).bind(id, companyId).first<Row>();
}

function jsonList(json: string): unknown[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function rolesOf(json: string): RoleKey[] {
  return [...new Set(jsonList(json).filter((r): r is RoleKey => typeof r === "string" && isRoleKey(r)))];
}

function tagsOf(json: string): string[] {
  return jsonList(json).filter((t): t is string => typeof t === "string");
}

export function workModesOf(remoteMode: string): WorkMode[] {
  const parts = remoteMode.split(",").map((p) => p.trim());
  return (["remote", "city"] as const).filter((m) => parts.includes(m));
}

function remoteModeOf(modes: readonly WorkMode[]): "remote" | "city" | "remote,city" {
  const remote = modes.includes("remote");
  const city = modes.includes("city");
  return remote && city ? "remote,city" : city ? "city" : "remote";
}

function salaryOf(r: Pick<Row, "salary_min" | "salary_max" | "salary_currency" | "salary_period">): Salary | null {
  if (!r.salary_currency || (r.salary_min === null && r.salary_max === null)) return null;
  return { min: r.salary_min, max: r.salary_max, currency: r.salary_currency, period: r.salary_period ?? "year" };
}

function expired(r: Pick<Row, "expires_at">, now: Date): boolean {
  return r.expires_at !== null && r.expires_at <= sqlTime(now);
}

/** Публічна адреса вакансії: https://nextcryptojob.xyz/jobs/<id> (SITE_URL з оточення). */
export function publicJobUrl(env: { SITE_URL?: string }, id: string): string {
  return `${siteOrigin(env)}/jobs/${id}`;
}

function toApi(r: Row, env: { SITE_URL?: string }): Job {
  const live = r.live === 1;
  return {
    job_id: r.id,
    status: r.status,
    title: r.title,
    description: r.description,
    roles: rolesOf(r.roles),
    work_mode: workModesOf(r.remote_mode),
    city: r.city,
    country: r.country,
    salary: salaryOf(r),
    apply_url: r.apply_url,
    tags: tagsOf(r.tags),
    live,
    created_at: isoTime(r.created_at),
    updated_at: isoTime(r.updated_at),
    published_at: isoTime(r.published_at),
    expires_at: isoTime(r.expires_at),
    closed_at: isoTime(r.closed_at),
    public_url: live ? publicJobUrl(env, r.id) : null,
    x_post: { state: r.x_post_state, url: r.x_post_url },
    stats: { digest_shown: r.digest_shown, apply_clicks: r.apply_clicks },
  };
}

// ---------------------------------------------------------------------------
// Поля

export interface JobFieldsInput {
  title: string;
  description: string;
  roles: readonly RoleKey[];
  work_mode: readonly WorkMode[];
  city: string | null;
  country: string | null;
  salary: { min?: number | null; max?: number | null; currency: string; period: "year" | "month" } | null;
  apply_url: string | null;
  tags: readonly string[];
}

export interface JobFields {
  title: string;
  description: string;
  roles: RoleKey[];
  workMode: WorkMode[];
  city: string | null;
  country: string | null;
  salary: Salary | null;
  applyUrl: string | null;
  tags: string[];
}

/** Та сама межа, що в показі, листі, search_jobs і engine (lib/digest/format.ts plausibleSalary). */
export const SALARY_RANGE_TEXT = "Enter a salary between 10,000 and 5,000,000 a year (834 to 416,666 a month).";
/** Керівні символи, крім табуляції й переносу рядка. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const CONTROL_ALL = new RegExp(CONTROL.source, "g");

/** Один рядок: пробіли стиснуто, по краях прибрано. */
function oneLine(v: string): string {
  return v.replace(/\s+/g, " ").trim();
}

/**
 * Адреса "Apply": https:// з хостом (без логіна в адресі) або mailto: з адресою.
 * Повертає нормалізовану адресу або null, якщо вона не підходить.
 */
export function applyUrlOf(raw: string): string | null {
  const v = raw.trim();
  if (!v || v.length > APPLY_URL_MAX) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol === "https:") return u.hostname.includes(".") && !u.username && !u.password ? u.href : null;
  if (u.protocol === "mailto:") {
    let to: string;
    try {
      to = decodeURIComponent(u.pathname);
    } catch {
      return null;
    }
    return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(to) ? u.href : null;
  }
  return null;
}

/**
 * Поля вакансії, перевірені цілком (після злиття зміни з наявним рядком): назва й
 * місто в один рядок, місто для режиму City, країна з переліку ISO, зарплата min ≤ max,
 * адреса https:// або mailto:, теги без повторів. Помилки всіх полів разом (422).
 */
export function checkJobFields(input: JobFieldsInput): JobFields {
  const errors: Record<string, string> = {};

  const title = oneLine(input.title);
  if (title.length < 3 || title.length > 120) errors.title = "Use 3 to 120 characters.";
  else if (CONTROL.test(title)) errors.title = "The title cannot contain control characters.";

  const description = input.description.replace(/\r\n?/g, "\n").replace(CONTROL_ALL, "").trim();

  const roles = [...new Set(input.roles)];
  if (roles.length < 1 || roles.length > 3) errors.roles = "Choose 1 to 3 roles.";

  const workMode = (["remote", "city"] as const).filter((m) => input.work_mode.includes(m));
  if (workMode.length === 0) errors.work_mode = "Choose Remote, City or both.";

  const city = input.city === null ? null : oneLine(input.city) || null;
  if (workMode.includes("city") && !city) errors.city = "Add the city of the office.";
  else if (city && (city.length > 80 || CONTROL.test(city))) errors.city = "Use up to 80 characters.";

  let country: string | null = null;
  if (input.country !== null && input.country !== "") {
    country = countryCode(input.country);
    if (!country) errors.country = "Pick a country from the list.";
  }

  let salary: Salary | null = null;
  if (input.salary) {
    const min = input.salary.min ?? null;
    const max = input.salary.max ?? null;
    const period = input.salary.period;
    if (min !== null && max !== null && min > max) errors.salary = "The minimum is above the maximum.";
    else if ((min !== null && !plausibleSalary(min, period)) || (max !== null && !plausibleSalary(max, period))) errors.salary = SALARY_RANGE_TEXT;
    else if (min !== null || max !== null) salary = { min, max, currency: input.salary.currency, period };
  }

  let applyUrl: string | null = null;
  if (input.apply_url !== null && input.apply_url.trim() !== "") {
    applyUrl = applyUrlOf(input.apply_url);
    if (!applyUrl) errors.apply_url = "Use an https:// link or a mailto: address.";
  }

  let tags: string[] = [];
  try {
    tags = normalizeTags(input.tags);
  } catch (e) {
    if (!(e instanceof ActionError)) throw e;
    errors.tags = String((e.details?.fields as Record<string, string> | undefined)?.tags ?? e.message);
  }

  if (Object.keys(errors).length > 0) throw fieldsError(errors);
  return { title, description, roles, workMode, city, country, salary, applyUrl, tags };
}

/** Місце вакансії для людей: «Remote», «Lisbon», «Remote or Lisbon». */
export function placeText(workMode: readonly WorkMode[], city: string | null): string {
  return [workMode.includes("remote") ? "Remote" : null, workMode.includes("city") ? city : null].filter(Boolean).join(" or ");
}

/**
 * Текст посту в X (специфікація 5.6), не довше 280 символів:
 * `{Company} is hiring: {Title} ({Remote | City}). {Salary if set} Apply: nextcryptojob.xyz/jobs/{id}`.
 * Задовгу назву (а потім і компанію) скорочуємо, адресу ніколи.
 */
export function xPostText(o: { company: string; fields: Pick<JobFields, "title" | "workMode" | "city" | "salary">; jobId: string; origin: string }): string {
  const host = new URL(o.origin).host;
  const place = placeText(o.fields.workMode, o.fields.city);
  const salary = o.fields.salary ? formatSalary(o.fields.salary) : null;
  const tail = `${salary ? ` Salary: ${salary}.` : ""} Apply: ${host}/jobs/${o.jobId}`;
  const clean = (s: string) => oneLine(s.replace(/\u2014/g, "-"));
  const build = (company: string, title: string) => `${company} is hiring: ${title}${place ? ` (${place})` : ""}.${tail}`;
  const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, Math.max(1, n - 3)).trimEnd()}...`);
  let company = clean(o.company);
  let title = clean(o.fields.title);
  let text = build(company, title);
  if (text.length > X_POST_MAX) {
    title = cut(title, title.length - (text.length - X_POST_MAX));
    text = build(company, title);
  }
  if (text.length > X_POST_MAX) {
    company = cut(company, company.length - (text.length - X_POST_MAX));
    text = build(company, title);
  }
  return text.slice(0, X_POST_MAX);
}

function fieldsOfRow(r: Row): JobFieldsInput {
  const salary = salaryOf(r);
  return {
    title: r.title,
    description: r.description,
    roles: rolesOf(r.roles),
    work_mode: workModesOf(r.remote_mode),
    city: r.city,
    country: r.country,
    salary,
    apply_url: r.apply_url,
    tags: tagsOf(r.tags),
  };
}

/** Колонки рядка з полів у порядку FIELD_COLUMNS. */
function fieldValues(f: JobFields): (string | number | null)[] {
  return [
    f.title,
    f.description,
    JSON.stringify(f.roles),
    remoteModeOf(f.workMode),
    f.city,
    f.country,
    f.salary?.min ?? null,
    f.salary?.max ?? null,
    f.salary?.currency ?? null,
    f.salary?.period ?? null,
    f.applyUrl,
    JSON.stringify(f.tags),
  ];
}

const FIELD_COLUMNS = [
  "title",
  "description",
  "roles",
  "remote_mode",
  "city",
  "country",
  "salary_min",
  "salary_max",
  "salary_currency",
  "salary_period",
  "apply_url",
  "tags",
] as const;

/** Умова межі відкритих вакансій для INSERT/UPDATE (параметри: company_id, now, id або '', межа). */
const UNDER_OPEN_LIMIT = `(SELECT COUNT(*) FROM company_jobs o
    WHERE o.company_id = ? AND o.status = 'open' AND o.expires_at > ? AND o.id <> ?) < ?`;

// ---------------------------------------------------------------------------
// Дії

export interface ListJobsInput {
  status?: "draft" | "open" | "closed";
  cursor?: string;
  limit?: number;
}

const cursorError = () => fieldsError({ cursor: "This cursor is not valid." });
const SQL_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function encodeCursor(value: object): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Курсор списку: позиція (updated_at, id) останньої відданої вакансії. Секрету немає: власні дані компанії. */
function openCursor(cursor: string): { u: string; id: string } {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw cursorError();
  let c: unknown;
  try {
    c = JSON.parse(atob(cursor.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    throw cursorError();
  }
  const v = c as { v?: unknown; u?: unknown; id?: unknown } | null;
  if (!v || v.v !== 1 || typeof v.u !== "string" || !SQL_TIME.test(v.u) || typeof v.id !== "string") throw cursorError();
  return { u: v.u, id: v.id };
}

/** Вакансії компанії, найсвіжіше змінені першими; фільтр стану. */
export async function listJobs(rawCtx: ActionContext, input: ListJobsInput): Promise<JobList> {
  const { ctx } = companyCtx(rawCtx);
  const limit = input.limit ?? DEFAULT_LIMIT;
  const where = ["j.company_id = ?"];
  const params: (string | number)[] = [ctx.company.id];
  if (input.status) {
    where.push("j.status = ?");
    params.push(input.status);
  }
  if (input.cursor) {
    const after = openCursor(input.cursor);
    where.push("(j.updated_at < ? OR (j.updated_at = ? AND j.id < ?))");
    params.push(after.u, after.u, after.id);
  }
  const { results } = await ctx.db
    .prepare(`SELECT ${COLUMNS} FROM company_jobs j WHERE ${where.join(" AND ")} ORDER BY j.updated_at DESC, j.id DESC LIMIT ?`)
    .bind(...params, limit + 1)
    .all<Row>();
  const page = results.slice(0, limit);
  const last = page.at(-1);
  return {
    data: page.map((r) => toApi(r, ctx.env)),
    next_cursor: results.length > limit && last ? encodeCursor({ v: 1, u: last.updated_at, id: last.id }) : null,
  };
}

export async function getJob(rawCtx: ActionContext, input: { job_id: string }): Promise<Job> {
  const { ctx } = companyCtx(rawCtx);
  const row = await rowOf(ctx.db, ctx.company.id, input.job_id);
  if (!row) throw notFound();
  return toApi(row, ctx.env);
}

export interface PostJobInput {
  title: string;
  description?: string;
  roles: RoleKey[];
  work_mode: WorkMode[];
  city?: string | null;
  country?: string | null;
  salary?: JobFieldsInput["salary"];
  apply_url?: string | null;
  tags?: string[];
  status?: "draft" | "open";
  post_on_x?: boolean;
}

const needsApplyUrl = () => fieldsError({ apply_url: "Add an apply link (https:// or mailto:) to publish." });

export async function postJob(rawCtx: ActionContext, input: PostJobInput): Promise<Job> {
  const { ctx, userId, keyId } = companyCtx(rawCtx);
  const f = checkJobFields({
    title: input.title,
    description: input.description ?? "",
    roles: input.roles,
    work_mode: input.work_mode,
    city: input.city ?? null,
    country: input.country ?? null,
    salary: input.salary ?? null,
    apply_url: input.apply_url ?? null,
    tags: input.tags ?? [],
  });
  const status = input.status ?? "draft";
  if (status === "open" && !f.applyUrl) throw needsApplyUrl();

  const id = newId("job");
  const now = ctx.now;
  const at = sqlTime(now);
  const open = status === "open";
  const queued = input.post_on_x === true;
  const text = queued ? xPostText({ company: ctx.company.name, fields: f, jobId: id, origin: siteOrigin(ctx.env) }) : null;
  const res = await ctx.db
    .prepare(
      `INSERT INTO company_jobs (id, company_id, status, ${FIELD_COLUMNS.join(", ")}, created_via, created_by_user_id,
                                 created_by_key_id, x_post_state, x_post_text, x_queued_at, published_at, expires_at,
                                 created_at, updated_at)
       SELECT ?, ?, ?, ${FIELD_COLUMNS.map(() => "?").join(", ")}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE ? = 0 OR ${UNDER_OPEN_LIMIT}`,
    )
    .bind(
      id,
      ctx.company.id,
      status,
      ...fieldValues(f),
      ctx.channel,
      userId,
      keyId,
      queued ? "queued" : "none",
      text,
      queued ? at : null,
      open ? at : null,
      open ? sqlTime(new Date(now.getTime() + JOB_LIFETIME_DAYS * DAY_MS)) : null,
      at,
      at,
      open ? 1 : 0,
      ctx.company.id,
      at,
      "",
      openJobLimit(ctx.company),
    )
    .run();
  if ((res.meta.changes ?? 0) !== 1) throw openLimitError(ctx.company);
  const row = await rowOf(ctx.db, ctx.company.id, id);
  if (!row) throw notFound();
  return toApi(row, ctx.env);
}

export interface UpdateJobInput extends Partial<Omit<PostJobInput, "status">> {
  job_id: string;
  status?: "draft" | "open";
}

/**
 * Зміна полів і (або) публікація. Поля зливаються з наявним рядком і перевіряються
 * цілком. `status: "open"` публікує чернетку, відкриває закриту знову або продовжує
 * прострочену на 60 днів; для живої відкритої дати не змінює. Нічого не змінилось:
 * рядок не пишеться, змін = false.
 */
export async function updateJob(rawCtx: ActionContext, input: UpdateJobInput): Promise<{ job: Job; changed: boolean }> {
  const { ctx } = companyCtx(rawCtx);
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await rowOf(ctx.db, ctx.company.id, input.job_id);
    if (!row) throw notFound();
    const before = fieldsOfRow(row);
    const f = checkJobFields({
      title: input.title ?? before.title,
      description: input.description ?? before.description,
      roles: input.roles ?? before.roles,
      work_mode: input.work_mode ?? before.work_mode,
      city: input.city !== undefined ? input.city : before.city,
      country: input.country !== undefined ? input.country : before.country,
      salary: input.salary !== undefined ? input.salary : before.salary,
      apply_url: input.apply_url !== undefined ? input.apply_url : before.apply_url,
      tags: input.tags ?? before.tags,
    });

    if (input.status === "draft" && row.status !== "draft") {
      throw fieldsError({
        status:
          row.status === "open"
            ? "A published job cannot go back to draft. Close it instead."
            : "A closed job cannot go back to draft. Publish it again.",
      });
    }
    const publish = input.status === "open" && (row.status !== "open" || expired(row, ctx.now));
    const status = publish ? "open" : row.status;
    if (status === "open" && !f.applyUrl) throw needsApplyUrl();

    let xState = row.x_post_state;
    let xQueuedAt = row.x_queued_at;
    if (input.post_on_x === true && xState === "none") {
      xState = "queued";
      xQueuedAt = sqlTime(ctx.now);
    } else if (input.post_on_x === false && xState === "queued") {
      xState = "none";
      xQueuedAt = null;
    }
    const xText =
      xState === "queued"
        ? xPostText({ company: ctx.company.name, fields: f, jobId: row.id, origin: siteOrigin(ctx.env) })
        : xState === "none"
          ? null
          : row.x_post_text;

    const at = sqlTime(ctx.now);
    const next = {
      values: fieldValues(f),
      status,
      published_at: publish ? at : row.published_at,
      expires_at: publish ? sqlTime(new Date(ctx.now.getTime() + JOB_LIFETIME_DAYS * DAY_MS)) : row.expires_at,
      closed_at: publish ? null : row.closed_at,
    };
    const old = FIELD_COLUMNS.map((c) => row[c]);
    const same =
      !publish && next.values.every((v, i) => v === old[i]) && xState === row.x_post_state && xText === row.x_post_text;
    if (same) return { job: toApi(row, ctx.env), changed: false };

    const res = await ctx.db
      .prepare(
        `UPDATE company_jobs SET ${FIELD_COLUMNS.map((c) => `${c} = ?`).join(", ")}, status = ?, published_at = ?, expires_at = ?,
                closed_at = ?, x_post_state = ?, x_post_text = ?, x_queued_at = ?, updated_at = ?
          WHERE id = ? AND company_id = ? AND status = ? AND (? = 0 OR ${UNDER_OPEN_LIMIT})`,
      )
      .bind(
        ...next.values,
        next.status,
        next.published_at,
        next.expires_at,
        next.closed_at,
        xState,
        xText,
        xQueuedAt,
        at,
        row.id,
        ctx.company.id,
        row.status,
        publish ? 1 : 0,
        ctx.company.id,
        at,
        row.id,
        openJobLimit(ctx.company),
      )
      .run();
    if ((res.meta.changes ?? 0) === 1) {
      const fresh = await rowOf(ctx.db, ctx.company.id, row.id);
      if (!fresh) throw notFound();
      return { job: toApi(fresh, ctx.env), changed: true };
    }
    // Не записалось: межа відкритих або вакансію саме закрили в іншій вкладці (тоді ще раз зі свіжим рядком).
    const current = await ctx.db
      .prepare("SELECT status FROM company_jobs WHERE id = ? AND company_id = ?")
      .bind(row.id, ctx.company.id)
      .first<{ status: string }>();
    if (!current) throw notFound();
    if (current.status === row.status && publish) throw openLimitError(ctx.company);
  }
  throw notFound();
}

/** Закрити: з добірок, пошуку й публічної сторінки одразу, з черги X ('skipped'). Уже закрита: без змін. */
export async function closeJob(rawCtx: ActionContext, input: { job_id: string }): Promise<{ job: Job; changed: boolean }> {
  const { ctx } = companyCtx(rawCtx);
  const at = sqlTime(ctx.now);
  const res = await ctx.db
    .prepare(
      `UPDATE company_jobs SET status = 'closed', closed_at = ?, updated_at = ?,
              x_post_state = CASE x_post_state WHEN 'queued' THEN 'skipped' ELSE x_post_state END
        WHERE id = ? AND company_id = ? AND status <> 'closed'`,
    )
    .bind(at, at, input.job_id, ctx.company.id)
    .run();
  const row = await rowOf(ctx.db, ctx.company.id, input.job_id);
  if (!row) throw notFound();
  return { job: toApi(row, ctx.env), changed: (res.meta.changes ?? 0) === 1 };
}

// ---------------------------------------------------------------------------
// Для екранів CRM

/** Id вакансій компанії, які сховав адмін (причина "Not live" у списку). */
export async function hiddenJobIds(ctx: ActionContext): Promise<Set<string>> {
  const { ctx: c } = companyCtx(ctx);
  const { results } = await c.db
    .prepare("SELECT id FROM company_jobs WHERE company_id = ? AND hidden_by_admin_at IS NOT NULL LIMIT 500")
    .bind(c.company.id)
    .all<{ id: string }>();
  return new Set(results.map((r) => r.id));
}

/** Скільки відкритих і не прострочених вакансій має компанія (те, що рахує межа плану). */
export async function openJobCount(ctx: ActionContext): Promise<number> {
  const { ctx: c } = companyCtx(ctx);
  const n = await c.db
    .prepare("SELECT COUNT(*) AS n FROM company_jobs WHERE company_id = ? AND status = 'open' AND expires_at > ?")
    .bind(c.company.id, sqlTime(c.now))
    .first<number>("n");
  return n ?? 0;
}

/** Чому вакансія не жива (специфікація 10.2); null, якщо жива. */
export function notLiveReason(job: Pick<Job, "live" | "status" | "expires_at">, o: { hidden: boolean; access: CompanyInfo["access"]; now: Date }): string | null {
  if (job.live) return null;
  if (job.status === "draft") return "Draft";
  if (job.status === "closed") return "Closed";
  if (o.hidden) return "Hidden by NextCryptoJob";
  if (job.expires_at && Date.parse(job.expires_at) <= o.now.getTime()) return "Expired";
  if (o.access !== "subscription") return "No active subscription";
  return "Not live";
}
