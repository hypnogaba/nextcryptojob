import type { z } from "zod";
import { newId } from "@/lib/ids";
import { isoTime, sqlTime } from "@/lib/time";
import type { ActionContext, CompanyInfo } from "./context";
import { SEATS } from "./quotas";
import { filtersHash } from "./search";
import {
  ActionError,
  SearchFilters,
  SORTS,
  type SavedSearch as SavedSearchSchema,
  type SavedSearchList as SavedSearchListSchema,
  type Sort,
} from "./types";

/**
 * Збережені пошуки компанії (специфікація CRM, 5.7): спільні для всієї команди,
 * до 20 на компанію (у пробному 5). Кожен запит фільтрує company_id актора:
 * чужий id → 404.
 *
 * «Нові» для щоденного сповіщення (cron, T11) рахуються від baseline_at (0017):
 * мить створення або останньої зміни фільтрів чи сортування. Тут жодного
 * пошуку не виконується: створення й зміна фільтрів лише ставлять baseline_at
 * і скидають last_match_count у NULL. last_match_count означає одне: скільки
 * кандидатів були новими в останньому сповіщенні (не скільки збігів зараз).
 * Фільтри одного пошуку можна змінити не більше 10 разів на добу UTC.
 */

export type SavedSearch = z.infer<typeof SavedSearchSchema>;
export type SavedSearchList = z.infer<typeof SavedSearchListSchema>;

type CompanyCtx = ActionContext & { company: CompanyInfo };

interface Row {
  id: string;
  name: string;
  filters_json: string;
  sort: string;
  alert: "off" | "daily";
  last_alert_at: string | null;
  last_match_count: number | null;
  created_at: string;
}

const COLUMNS = "id, name, filters_json, sort, alert, last_alert_at, last_match_count, created_at";

function companyCtx(ctx: ActionContext): { ctx: CompanyCtx; userId: string | null; keyId: string | null } {
  if (!ctx.company) throw new ActionError("unauthorized", 401, "Sign in or send an API key.");
  if (ctx.actor.kind === "member") return { ctx: ctx as CompanyCtx, userId: ctx.actor.userId, keyId: null };
  if (ctx.actor.kind === "agent") return { ctx: ctx as CompanyCtx, userId: null, keyId: ctx.actor.keyId };
  throw new ActionError("forbidden", 403, "Only company members and agents can use saved searches.");
}

/** Межа збережених пошуків за планом (розділ 9). */
export function savedSearchLimit(company: Pick<CompanyInfo, "plan">): number {
  if (company.plan === "trial") return SEATS.trial.savedSearches;
  if (company.plan === "subscription") return SEATS.subscription.savedSearches;
  return 0;
}

function toApi(row: Row): SavedSearch {
  let filters: SearchFilters = {};
  try {
    const parsed = SearchFilters.safeParse(JSON.parse(row.filters_json));
    if (parsed.success) filters = parsed.data;
  } catch {
    // Зіпсований JSON фільтрів: показуємо пошук без фільтрів, а не падаємо.
  }
  const sort: Sort = (SORTS as readonly string[]).includes(row.sort) ? (row.sort as Sort) : "score";
  return {
    saved_search_id: row.id,
    name: row.name,
    filters,
    sort,
    alert: row.alert,
    last_alert_at: isoTime(row.last_alert_at),
    last_match_count: row.last_match_count,
    created_at: isoTime(row.created_at),
  };
}

const notFound = () => new ActionError("not_found", 404, "This saved search was not found.");

/** Скільки разів на добу UTC можна змінити фільтри одного збереженого пошуку. */
export const FILTER_CHANGES_PER_DAY = 10;

async function rowOf(db: D1Database, companyId: string, id: string): Promise<Row | null> {
  return db.prepare(`SELECT ${COLUMNS} FROM saved_searches WHERE id = ? AND company_id = ?`).bind(id, companyId).first<Row>();
}

export async function listSavedSearches(rawCtx: ActionContext): Promise<SavedSearchList> {
  const { ctx } = companyCtx(rawCtx);
  const { results } = await ctx.db
    .prepare(`SELECT ${COLUMNS} FROM saved_searches WHERE company_id = ? ORDER BY created_at DESC, id DESC LIMIT 100`)
    .bind(ctx.company.id)
    .all<Row>();
  return { data: results.map(toApi) };
}

function cleanName(raw: string): string {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) {
    throw new ActionError("validation_failed", 422, "Some fields are not valid.", { fields: { name: "Give the search a name." } });
  }
  return name;
}

export interface SavedSearchCreateInput {
  name: string;
  filters: SearchFilters;
  sort?: Sort;
  alert?: "off" | "daily";
}

/**
 * Новий збережений пошук. Спершу межа місць (дешевий підрахунок), потім запис,
 * де та сама межа стоїть у самому INSERT: дві паралельні спроби її не перевищать.
 */
export async function createSavedSearch(rawCtx: ActionContext, input: SavedSearchCreateInput): Promise<SavedSearch> {
  const { ctx, userId, keyId } = companyCtx(rawCtx);
  const limit = savedSearchLimit(ctx.company);
  const full = () =>
    new ActionError(
      "quota_exceeded",
      403,
      ctx.company.plan === "trial"
        ? `Your trial allows ${limit} saved searches. Delete one or subscribe for up to ${SEATS.subscription.savedSearches}.`
        : `You can keep up to ${limit} saved searches. Delete one first.`,
      { limit },
    );
  const used = await ctx.db
    .prepare("SELECT COUNT(*) AS n FROM saved_searches WHERE company_id = ?")
    .bind(ctx.company.id)
    .first<number>("n");
  if ((used ?? 0) >= limit) throw full();

  const name = cleanName(input.name);
  const id = newId("ss");
  const at = sqlTime(ctx.now);
  const res = await ctx.db
    .prepare(
      `INSERT INTO saved_searches (id, company_id, name, filters_json, sort, alert, created_via, created_by_user_id,
                                   created_by_key_id, last_match_count, baseline_at, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?
        WHERE (SELECT COUNT(*) FROM saved_searches WHERE company_id = ?) < ?`,
    )
    .bind(
      id,
      ctx.company.id,
      name,
      JSON.stringify(input.filters),
      input.sort ?? "score",
      input.alert ?? "daily",
      ctx.channel,
      userId,
      keyId,
      at,
      at,
      at,
      ctx.company.id,
      limit,
    )
    .run();
  if ((res.meta.changes ?? 0) !== 1) throw full();
  const row = await rowOf(ctx.db, ctx.company.id, id);
  if (!row) throw notFound();
  return toApi(row);
}

export interface SavedSearchUpdateInput {
  saved_search_id: string;
  name?: string;
  filters?: SearchFilters;
  sort?: Sort;
  alert?: "off" | "daily";
}

function secondsToNextUtcDay(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/**
 * Змінити назву, фільтри, сортування або сповіщення. Нові фільтри чи сортування
 * (справді інші, ніж були) ставлять baseline_at = зараз, last_match_count = NULL
 * і рахуються в межу FILTER_CHANGES_PER_DAY; межа перевіряється в самому UPDATE.
 */
export async function updateSavedSearch(rawCtx: ActionContext, input: SavedSearchUpdateInput): Promise<SavedSearch> {
  const { ctx } = companyCtx(rawCtx);
  const row = await rowOf(ctx.db, ctx.company.id, input.saved_search_id);
  if (!row) throw notFound();
  const current = toApi(row);

  const set: string[] = [];
  const values: (string | number | null)[] = [];
  if (input.name !== undefined) {
    set.push("name = ?");
    values.push(cleanName(input.name));
  }
  if (input.alert !== undefined) {
    set.push("alert = ?");
    values.push(input.alert);
  }
  const filters = input.filters ?? current.filters;
  const sort = input.sort ?? current.sort;
  const at = sqlTime(ctx.now);
  const day = at.slice(0, 10);
  const changed = (await filtersHash(filters, sort)) !== (await filtersHash(current.filters, current.sort));
  const guard: string[] = [];
  const guardValues: (string | number)[] = [];
  if (changed) {
    set.push(
      "filters_json = ?",
      "sort = ?",
      "baseline_at = ?",
      "last_match_count = NULL",
      "filter_changes = CASE WHEN filter_changes_day = ? THEN filter_changes + 1 ELSE 1 END",
      "filter_changes_day = ?",
    );
    values.push(JSON.stringify(filters), sort, at, day, day);
    guard.push("(filter_changes_day IS NOT ? OR filter_changes < ?)");
    guardValues.push(day, FILTER_CHANGES_PER_DAY);
  }
  set.push("updated_at = ?");
  values.push(at);
  const res = await ctx.db
    .prepare(`UPDATE saved_searches SET ${set.join(", ")} WHERE id = ? AND company_id = ?${guard.map((g) => ` AND ${g}`).join("")}`)
    .bind(...values, row.id, ctx.company.id, ...guardValues)
    .run();
  if ((res.meta.changes ?? 0) !== 1) {
    if (changed && (await rowOf(ctx.db, ctx.company.id, row.id))) {
      const retry = secondsToNextUtcDay(ctx.now);
      throw new ActionError(
        "daily_quota_exceeded",
        429,
        `You can change the filters of one saved search up to ${FILTER_CHANGES_PER_DAY} times a day. It resets at 00:00 UTC.`,
        { limit: FILTER_CHANGES_PER_DAY, retry_after: retry },
        { "Retry-After": String(retry) },
      );
    }
    throw notFound();
  }
  const after = await rowOf(ctx.db, ctx.company.id, row.id);
  if (!after) throw notFound();
  return toApi(after);
}

export async function deleteSavedSearch(rawCtx: ActionContext, input: { saved_search_id: string }): Promise<void> {
  const { ctx } = companyCtx(rawCtx);
  const res = await ctx.db
    .prepare("DELETE FROM saved_searches WHERE id = ? AND company_id = ?")
    .bind(input.saved_search_id, ctx.company.id)
    .run();
  if ((res.meta.changes ?? 0) !== 1) throw notFound();
}
