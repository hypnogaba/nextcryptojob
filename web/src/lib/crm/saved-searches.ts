import type { z } from "zod";
import { newId } from "@/lib/ids";
import { isoTime, sqlTime } from "@/lib/time";
import type { ActionContext, CompanyInfo } from "./context";
import { SEATS } from "./quotas";
import { matchingIds } from "./search";
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
 * до 20 на компанію (у пробному 5). При створенні й при зміні фільтрів поточні
 * збіги (до 200) записуються в seen_json, тож щоденне сповіщення (cron, T11)
 * каже лише про нових. Кожен запит фільтрує company_id актора: чужий id → 404.
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
 * Новий збережений пошук. Межа місць перевіряється в самому INSERT (без проміжку
 * між підрахунком і записом): дві паралельні спроби не перевищать межу.
 */
export async function createSavedSearch(rawCtx: ActionContext, input: SavedSearchCreateInput): Promise<SavedSearch> {
  const { ctx, userId, keyId } = companyCtx(rawCtx);
  const limit = savedSearchLimit(ctx.company);
  const name = cleanName(input.name);
  const sort = input.sort ?? "score";
  const seen = await matchingIds(ctx, input.filters, sort);
  const id = newId("ss");
  const at = sqlTime(ctx.now);
  const res = await ctx.db
    .prepare(
      `INSERT INTO saved_searches (id, company_id, name, filters_json, sort, alert, created_via, created_by_user_id,
                                   created_by_key_id, seen_json, last_match_count, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE (SELECT COUNT(*) FROM saved_searches WHERE company_id = ?) < ?`,
    )
    .bind(
      id,
      ctx.company.id,
      name,
      JSON.stringify(input.filters),
      sort,
      input.alert ?? "daily",
      ctx.channel,
      userId,
      keyId,
      JSON.stringify(seen),
      seen.length,
      at,
      at,
      ctx.company.id,
      limit,
    )
    .run();
  if ((res.meta.changes ?? 0) !== 1) {
    throw new ActionError(
      "quota_exceeded",
      403,
      ctx.company.plan === "trial"
        ? `Your trial allows ${limit} saved searches. Delete one or subscribe for up to ${SEATS.subscription.savedSearches}.`
        : `You can keep up to ${limit} saved searches. Delete one first.`,
      { limit },
    );
  }
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

/** Змінити назву, фільтри, сортування або сповіщення. Нові фільтри: поточні збіги знову «бачені». */
export async function updateSavedSearch(rawCtx: ActionContext, input: SavedSearchUpdateInput): Promise<SavedSearch> {
  const { ctx } = companyCtx(rawCtx);
  const row = await rowOf(ctx.db, ctx.company.id, input.saved_search_id);
  if (!row) throw notFound();
  const current = toApi(row);

  const set: string[] = [];
  const values: (string | number)[] = [];
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
  if (input.filters !== undefined || input.sort !== undefined) {
    const seen = await matchingIds(ctx, filters, sort);
    set.push("filters_json = ?", "sort = ?", "seen_json = ?", "last_match_count = ?");
    values.push(JSON.stringify(filters), sort, JSON.stringify(seen), seen.length);
  }
  set.push("updated_at = ?");
  values.push(sqlTime(ctx.now));
  const res = await ctx.db
    .prepare(`UPDATE saved_searches SET ${set.join(", ")} WHERE id = ? AND company_id = ?`)
    .bind(...values, row.id, ctx.company.id)
    .run();
  if ((res.meta.changes ?? 0) !== 1) throw notFound();
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
