"use server";

import type { FormMessage } from "@/components/form/form-message";
import { runAction } from "@/lib/crm/actions";
import { assertFormCompany, userFacingError } from "@/lib/crm/company";
import { resolveWebActor } from "@/lib/crm/context";
import type { PipelineCard } from "@/lib/crm/pipeline";
import { paramsFromQuery, parseSearchParams } from "@/lib/crm/search-params";
import type { SearchResponse, Stage } from "@/lib/crm/types";

/**
 * Дії сторінки пошуку (W2). Кожна визначає актора з сесії (server action це
 * публічна кінцева точка), порівнює прихований id компанії з компанією сесії
 * (друга вкладка могла перемкнути компанію) і йде через реєстр дій: право,
 * доступ, квота, журнал. Сторінку пошуку не оновлюють: її повторний показ
 * витратив би ще одну сторінку квоти пошуку.
 */

export type LoadMoreResult = { ok: true; page: SearchResponse } | { ok: false; error: string };

/** "Load more": наступна сторінка того самого пошуку за курсором. */
export async function loadMoreAction(input: { companyId: string; query: string; cursor: string }): Promise<LoadMoreResult> {
  try {
    const ctx = await resolveWebActor();
    assertFormCompany(ctx, input.companyId);
    const parsed = parseSearchParams(paramsFromQuery(input.query));
    const res = await runAction(
      "search_candidates",
      { filters: parsed.filters, sort: parsed.sort, cursor: input.cursor },
      ctx,
    );
    return { ok: true, page: res.output as SearchResponse };
  } catch (err) {
    const known = userFacingError(err);
    if (!known) throw err;
    return { ok: false, error: known.message };
  }
}

export type AddResult = { ok: true; stage: Stage; tags: string[] } | { ok: false; error: string };

/** "Add to pipeline" з рядка результату. */
export async function addFromSearchAction(input: { companyId: string; candidateId: string; role?: string }): Promise<AddResult> {
  try {
    const ctx = await resolveWebActor();
    assertFormCompany(ctx, input.companyId);
    const res = await runAction(
      "add_to_pipeline",
      { candidate_id: input.candidateId, ...(input.role ? { role: input.role } : {}) },
      ctx,
    );
    const card = res.output as PipelineCard;
    return { ok: true, stage: card.stage, tags: card.tags };
  } catch (err) {
    const known = userFacingError(err);
    if (!known) throw err;
    return { ok: false, error: known.message };
  }
}

export type SaveSearchState = { message?: FormMessage; error?: string; name?: string };

/** "Save search": назва + ті самі фільтри, що в адресі сторінки. */
export async function saveSearchAction(_prev: SaveSearchState, form: FormData): Promise<SaveSearchState> {
  const name = String(form.get("name") ?? "");
  const parsed = parseSearchParams(paramsFromQuery(String(form.get("query") ?? "")));
  try {
    const ctx = await resolveWebActor();
    assertFormCompany(ctx, form.get("company_id"));
    await runAction(
      "create_saved_search",
      { name, filters: parsed.filters, sort: parsed.sort, alert: form.get("alert") === "off" ? "off" : "daily" },
      ctx,
    );
  } catch (err) {
    const known = userFacingError(err);
    if (!known) throw err;
    return { error: known.fields?.name ?? known.message, name };
  }
  return { message: { tone: "success", text: "Saved. You get a daily email when new candidates match." } };
}
