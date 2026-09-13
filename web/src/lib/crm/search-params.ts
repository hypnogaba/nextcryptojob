import { isRoleKey } from "@/lib/card/roles";
import { CHAIN_TEXT, roleText } from "./labels";
import { CHAINS, SearchFilters, SORTS, type Chain, type Sort } from "./types";

/**
 * Фільтри пошуку (5.2) у адресі сторінки /company/search і назад. Форма
 * фільтрів іде звичайним GET: сторінку можна відкрити посиланням (збережений
 * пошук "Run"), кнопка "Back" повертає попередні фільтри. Пошук виконується
 * лише з `q=1` (натиснуто "Search"): кожна сторінка пошуку витрачає квоту.
 */

type Params = Record<string, string | string[] | undefined>;

export interface ParsedSearch {
  filters: SearchFilters;
  sort: Sort;
  /** Поле форми → текст помилки. */
  errors: Record<string, string>;
  /** Людина натиснула "Search" (або відкрила збережений пошук). */
  run: boolean;
}

function one(params: Params, key: string): string {
  const v = params[key];
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
}

function many(params: Params, key: string): string[] {
  const v = params[key];
  return (Array.isArray(v) ? v : v === undefined ? [] : [v]).map((s) => s.trim()).filter(Boolean);
}

function int(params: Params, key: string, errors: Record<string, string>, min: number, max: number): number | undefined {
  const raw = one(params, key);
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    errors[key] = `Enter a whole number from ${min} to ${max}.`;
    return undefined;
  }
  return n;
}

/** Рядок адреси → параметри як у searchParams сторінки (повтори, напр. chains, стають масивом). */
export function paramsFromQuery(query: string): Params {
  const out: Params = {};
  for (const [k, v] of new URLSearchParams(query)) {
    const prev = out[k];
    out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return out;
}

/** Адреса → фільтри (перевірені тією самою схемою, що й дія search_candidates). */
export function parseSearchParams(params: Params): ParsedSearch {
  const errors: Record<string, string> = {};
  const draft: Record<string, unknown> = {};

  const role = one(params, "role");
  if (role) {
    if (isRoleKey(role)) draft.role = role;
    else errors.role = "Choose a role from the list.";
  }
  draft.min_score = int(params, "min_score", errors, 0, 100);
  draft.min_level = int(params, "min_level", errors, 1, 10);
  draft.max_level = int(params, "max_level", errors, 1, 10);
  draft.min_coverage = int(params, "min_coverage", errors, 0, 100);

  const chains = [...new Set(many(params, "chains"))].filter((c): c is Chain => (CHAINS as readonly string[]).includes(c));
  if (chains.length) draft.chains = chains;

  const years = one(params, "years");
  if (years) {
    const n = Number(years);
    if (n === 1 || n === 2 || n === 4 || n === 6) draft.min_onchain_years = n;
    else errors.years = "Choose how many years onchain.";
  }

  const work = one(params, "work");
  if (work === "remote" || work === "city") draft.work_mode = work;
  const city = one(params, "city");
  if (work === "city") draft.city = city;

  if (one(params, "x_verified") === "1") draft.x_verified = true;
  if (one(params, "wallet_verified") === "1") draft.wallet_verified = true;
  if (one(params, "contact_direct") === "1") draft.contact_direct = true;
  if (one(params, "hide_pipeline") === "1") draft.exclude_in_pipeline = true;

  for (const k of Object.keys(draft)) if (draft[k] === undefined) delete draft[k];

  const sortRaw = one(params, "sort");
  const sort: Sort = (SORTS as readonly string[]).includes(sortRaw) ? (sortRaw as Sort) : "score";

  const parsed = SearchFilters.safeParse(draft);
  let filters: SearchFilters = {};
  if (parsed.success) {
    filters = parsed.data;
  } else {
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? "filters");
      const key = field === "work_mode" ? "work" : field === "min_onchain_years" ? "years" : field;
      errors[key] ??= issue.message;
    }
  }
  return { filters, sort, errors, run: one(params, "q") === "1" && Object.keys(errors).length === 0 };
}

/** Фільтри → рядок адреси /company/search?… (з `q=1`, щоб одразу шукати). */
export function searchQuery(filters: SearchFilters, sort: Sort = "score", run = true): string {
  const q = new URLSearchParams();
  if (filters.role) q.set("role", filters.role);
  if (filters.min_score !== undefined) q.set("min_score", String(filters.min_score));
  if (filters.min_level !== undefined) q.set("min_level", String(filters.min_level));
  if (filters.max_level !== undefined) q.set("max_level", String(filters.max_level));
  for (const c of filters.chains ?? []) q.append("chains", c);
  if (filters.min_onchain_years !== undefined) q.set("years", String(filters.min_onchain_years));
  if (filters.work_mode) q.set("work", filters.work_mode);
  if (filters.work_mode === "city" && filters.city) q.set("city", filters.city);
  if (filters.x_verified) q.set("x_verified", "1");
  if (filters.wallet_verified) q.set("wallet_verified", "1");
  if (filters.contact_direct) q.set("contact_direct", "1");
  if (filters.exclude_in_pipeline) q.set("hide_pipeline", "1");
  if (filters.min_coverage !== undefined) q.set("min_coverage", String(filters.min_coverage));
  if (sort !== "score") q.set("sort", sort);
  if (run) q.set("q", "1");
  return q.toString();
}

const SORT_TEXT: Record<Sort, string> = {
  score: "by score",
  level: "by level",
  coverage: "by coverage",
  newest: "newest first",
};

/** Короткий опис фільтрів для списку збережених пошуків. */
export function describeFilters(filters: SearchFilters, sort: Sort = "score"): string {
  const parts: string[] = [filters.role ? roleText(filters.role) : "Any role"];
  if (filters.min_score !== undefined) parts.push(`score ${filters.min_score}+`);
  if (filters.min_level !== undefined && filters.max_level !== undefined) {
    parts.push(`level ${filters.min_level} to ${filters.max_level}`);
  } else if (filters.min_level !== undefined) {
    parts.push(`level ${filters.min_level}+`);
  } else if (filters.max_level !== undefined) {
    parts.push(`level up to ${filters.max_level}`);
  }
  if (filters.chains?.length) parts.push(filters.chains.map((c) => CHAIN_TEXT[c]).join(" or "));
  if (filters.min_onchain_years !== undefined) parts.push(`${filters.min_onchain_years}+ years onchain`);
  if (filters.work_mode === "remote") parts.push("remote");
  if (filters.work_mode === "city" && filters.city) parts.push(`in ${filters.city}`);
  if (filters.x_verified) parts.push("X verified");
  if (filters.wallet_verified) parts.push("wallet verified");
  if (filters.contact_direct) parts.push("Telegram available");
  if (filters.min_coverage !== undefined) parts.push(`coverage ${filters.min_coverage}%+`);
  if (filters.exclude_in_pipeline) parts.push("not in pipeline");
  parts.push(SORT_TEXT[sort]);
  return parts.join(", ");
}
