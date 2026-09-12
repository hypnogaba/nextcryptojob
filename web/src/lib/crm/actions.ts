import { z } from "zod";
import { isoTime } from "@/lib/time";
import { readX402Config, type PaidAction } from "@/lib/x402/config";
import type { SettleTiming } from "@/lib/x402/server";
import { auditStatement, type AuditMeta } from "./audit";
import { actorRole, type AccessMode, type ActionContext, type Channel } from "./context";
import { assertCan, type Permission } from "./permissions";
import { loadCandidates, projectHidden, projectIntro, projectProfile, contactFromIntro, INTRO_COLUMNS, type IntroRow } from "./project";
import {
  finishUsageStatement,
  quotaError,
  quotaPlan,
  quotasForAccount,
  quotaStates,
  rateLimitHeaders,
  reserveUsage,
  usageStatement,
  type QuotaName,
  type QuotaState,
  type QuotaSubject,
  type UsageRecord,
} from "./quotas";
import { searchCandidates } from "./search";
import * as T from "./types";
import { ActionError, validationError } from "./types";
import { isVisibleTo } from "./visibility";

/**
 * Єдиний реєстр дій (специфікація CRM, 3.2 і 5.1). Кожна дія описана один раз:
 * назва, REST (метод, шлях, статус), інструмент MCP, вхід і вихід (zod), право,
 * доступ компанії, ціна x402, квоти, дія журналу, момент розрахунку x402.
 * Server actions інтерфейсу, маршрути REST (T9) і інструменти MCP (T10)
 * викликають runAction / prepareAction + executeAction з різним контекстом.
 *
 * Вхід = параметри шляху + параметри запиту + тіло REST, злиті в один об'єкт
 * (docs/api/mcp-tools.md). Вихід = тіло успішної відповіді REST.
 * Тест actions.test.ts звіряє реєстр з openapi.yaml і mcp-tools.md.
 *
 * Обробники (handler) є в діях T2–T3 (get_account, search_candidates,
 * get_candidate); решту допишуть T4–T12. Дія без обробника відповідає 501
 * not_implemented ще до перевірки оплати.
 */

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface HandlerResult<O> {
  output: O;
  /** Статус REST, якщо не типовий (напр. 200 замість 201 для вже наявної картки). */
  status?: number;
  /** Скільки кандидатів повернуто (usage_events.results). */
  results?: number | null;
  /** Уточнення запису журналу: інша назва дії, ціль, meta. */
  audit?: { action?: string; target?: string | null; meta?: AuditMeta };
}

export interface ActionDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  rest: { method: HttpMethod; path: string; status: number; operationId: string };
  mcp: {
    tool: string;
    annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  };
  input: I;
  output: O;
  /** Право з матриці 2.2; `public` = без входу (search_jobs). */
  permission: Permission | "public";
  /** Режими доступу компанії (2.3), у яких дія дозволена. */
  access: readonly AccessMode[];
  /** Канали; типово всі. */
  channels?: readonly Channel[];
  /** Ціна x402 у доларах і кому вона (гість, компанія без підписки, усі). */
  price?: { usd: string; payers: readonly ("x402_guest" | "pay_per_request" | "subscription")[] };
  settle?: SettleTiming;
  quota?: readonly QuotaName[];
  /** Назва дії журналу; обов'язкова, якщо дія торкається кандидата. */
  audit?: string;
  /** Дія над кандидатом (5.1: кожна пише audit_log). */
  touchesCandidate?: boolean;
  handler?: (ctx: ActionContext, input: z.output<I>) => Promise<HandlerResult<z.output<O>>>;
}

function defineAction<const N extends string, I extends z.ZodType, O extends z.ZodType>(
  def: ActionDef<I, O> & { name: N },
): ActionDef<I, O> & { name: N } {
  return def;
}

const ALL_ACCESS = ["subscription", "pay_per_request"] as const;
const SUBSCRIPTION_ONLY = ["subscription"] as const;
const READ = { readOnlyHint: true } as const;

const withCandidate = <S extends z.ZodRawShape>(shape: S) => z.strictObject({ candidate_id: T.CandidateId, ...shape });
const cursorLimit50 = { cursor: T.Cursor.optional(), limit: T.Limit50.optional() };

/** Хоч одне поле, крім id шляху (minProperties: 1 тіла REST). */
const atLeastOne =
  (idKey: string) =>
  (v: Record<string, unknown>): boolean =>
    Object.keys(v).some((k) => k !== idKey && v[k] !== undefined);

// ---------------------------------------------------------------------------
// Реєстр

export const ACTIONS = [
  defineAction({
    name: "get_account",
    description:
      "Returns your company, access mode (subscription or pay per request), quotas left today and x402 prices. Call this first.",
    rest: { method: "GET", path: "/me", status: 200, operationId: "getAccount" },
    mcp: { tool: "get_account", annotations: READ },
    input: T.Empty,
    output: T.Account,
    permission: "account.read",
    access: ["subscription", "pay_per_request", "none"],
    handler: getAccount,
  }),
  defineAction({
    name: "search_candidates",
    description:
      "Search anonymous profiles of candidates who chose to be visible to companies. Returns up to 20 per page, max 10 pages per query. No names, handles, wallets or emails.",
    rest: { method: "POST", path: "/candidates/search", status: 200, operationId: "searchCandidates" },
    mcp: { tool: "search_candidates", annotations: READ },
    input: T.SearchRequest,
    output: T.SearchResponse,
    permission: "candidates.search",
    access: ALL_ACCESS,
    price: { usd: "0.50", payers: ["x402_guest", "pay_per_request"] },
    settle: "before_response",
    quota: ["search_candidates"],
    audit: "candidate.search",
    touchesCandidate: true,
    handler: async (ctx, input) => {
      const output = await searchCandidates(ctx, input);
      return {
        output,
        results: output.data.length,
        audit: { meta: { ids: output.data.map((d) => d.candidate_id), page: output.page } },
      };
    },
  }),
  defineAction({
    name: "get_candidate",
    description:
      "Full anonymous profile with the score breakdown per chosen role. Contact appears only after an accepted intro or in direct mode.",
    rest: { method: "GET", path: "/candidates/{candidate_id}", status: 200, operationId: "getCandidate" },
    mcp: { tool: "get_candidate", annotations: READ },
    input: withCandidate({}),
    output: T.CandidateView,
    permission: "candidates.view",
    access: ALL_ACCESS,
    quota: ["get_candidate"],
    audit: "candidate.view",
    touchesCandidate: true,
    handler: getCandidate,
  }),
  defineAction({
    name: "list_pipeline",
    description: "Pipeline cards, newest activity first, with counts per stage.",
    rest: { method: "GET", path: "/pipeline", status: 200, operationId: "listPipeline" },
    mcp: { tool: "list_pipeline", annotations: READ },
    input: z.strictObject({
      stage: T.Stage.optional(),
      tag: z.string().max(32).optional(),
      job_id: T.JobId.optional(),
      ...cursorLimit50,
    }),
    output: T.PipelineList,
    permission: "pipeline.read",
    access: ALL_ACCESS,
  }),
  defineAction({
    name: "add_to_pipeline",
    description: "Add a candidate to the pipeline at stage Found. Idempotent: returns the existing card if there is one.",
    rest: { method: "PUT", path: "/pipeline/{candidate_id}", status: 201, operationId: "addToPipeline" },
    mcp: { tool: "add_to_pipeline", annotations: { idempotentHint: true } },
    input: withCandidate(T.PipelineAdd.shape),
    output: T.PipelineCard,
    permission: "pipeline.write",
    access: ALL_ACCESS,
    audit: "pipeline.add",
    touchesCandidate: true,
  }),
  defineAction({
    name: "update_stage",
    description:
      "Move a card to found, interview, hired or declined, and/or change tags or the linked job. Interview and hired need a shared contact.",
    rest: { method: "PATCH", path: "/pipeline/{candidate_id}", status: 200, operationId: "updatePipelineCard" },
    mcp: { tool: "update_stage", annotations: {} },
    input: withCandidate(T.PipelineUpdate.shape).refine(atLeastOne("candidate_id"), {
      message: "Send at least one of stage, tags or job_id.",
    }),
    output: T.PipelineCard,
    permission: "pipeline.write",
    access: ALL_ACCESS,
    audit: "pipeline.stage",
    touchesCandidate: true,
  }),
  defineAction({
    name: "remove_from_pipeline",
    description: "Remove the card and its notes. A pending intro is canceled first.",
    rest: { method: "DELETE", path: "/pipeline/{candidate_id}", status: 204, operationId: "removeFromPipeline" },
    mcp: { tool: "remove_from_pipeline", annotations: { destructiveHint: true } },
    input: withCandidate({}),
    output: T.Empty,
    permission: "pipeline.write",
    access: ALL_ACCESS,
    audit: "pipeline.remove",
    touchesCandidate: true,
  }),
  defineAction({
    name: "list_candidate_history",
    description: "History of one card (stage changes, notes, tags, intro events), oldest first.",
    rest: { method: "GET", path: "/pipeline/{candidate_id}/events", status: 200, operationId: "listCandidateHistory" },
    mcp: { tool: "list_candidate_history", annotations: READ },
    input: withCandidate(cursorLimit50),
    output: T.PipelineEventList,
    permission: "pipeline.read",
    access: ALL_ACCESS,
  }),
  defineAction({
    name: "add_note",
    description: "Add a private note to the card. Notes are append-only.",
    rest: { method: "POST", path: "/pipeline/{candidate_id}/notes", status: 201, operationId: "addNote" },
    mcp: { tool: "add_note", annotations: {} },
    input: withCandidate(T.NoteCreate.shape),
    output: T.PipelineEvent,
    permission: "pipeline.write",
    access: ALL_ACCESS,
    audit: "pipeline.note",
    touchesCandidate: true,
  }),
  defineAction({
    name: "request_intro",
    description:
      "Ask the candidate for an intro. They get your company name, your message and the linked job, and have 14 days to accept. If they accept, you get their Telegram handle (or email). In direct mode the contact comes back at once.",
    rest: { method: "POST", path: "/intros", status: 201, operationId: "requestIntro" },
    mcp: { tool: "request_intro", annotations: { openWorldHint: true } },
    input: T.IntroCreate,
    output: T.Intro,
    permission: "intros.write",
    access: ALL_ACCESS,
    price: { usd: "5.00", payers: ["pay_per_request"] },
    settle: "before_effect",
    quota: ["request_intro_day", "request_intro_month"],
    audit: "intro.request",
    touchesCandidate: true,
  }),
  defineAction({
    name: "list_intros",
    description: "List intros, most recently updated first. Poll with updated_since instead of (or with) the webhook.",
    rest: { method: "GET", path: "/intros", status: 200, operationId: "listIntros" },
    mcp: { tool: "list_intros", annotations: READ },
    input: z.strictObject({ status: T.IntroStatus.optional(), updated_since: T.IsoDateTime.optional(), ...cursorLimit50 }),
    output: T.IntroList,
    permission: "intros.read",
    access: ALL_ACCESS,
  }),
  defineAction({
    name: "intro_status",
    description: "Status of one intro. The contact is included after acceptance.",
    rest: { method: "GET", path: "/intros/{intro_id}", status: 200, operationId: "getIntro" },
    mcp: { tool: "intro_status", annotations: READ },
    input: z.strictObject({ intro_id: T.IntroId }),
    output: T.Intro,
    permission: "intros.read",
    access: ALL_ACCESS,
  }),
  defineAction({
    name: "cancel_intro",
    description: "Withdraw a pending intro. An x402 payment is not refunded.",
    rest: { method: "POST", path: "/intros/{intro_id}/cancel", status: 200, operationId: "cancelIntro" },
    mcp: { tool: "cancel_intro", annotations: { destructiveHint: true } },
    input: z.strictObject({ intro_id: T.IntroId }),
    output: T.Intro,
    permission: "intros.write",
    access: ALL_ACCESS,
    audit: "intro.cancel",
    touchesCandidate: true,
  }),
  defineAction({
    name: "list_jobs",
    description: "This company's jobs.",
    rest: { method: "GET", path: "/jobs", status: 200, operationId: "listJobs" },
    mcp: { tool: "list_jobs", annotations: READ },
    input: z.strictObject({ status: z.enum(["draft", "open", "closed"]).optional(), ...cursorLimit50 }),
    output: T.JobList,
    permission: "jobs.read",
    access: ALL_ACCESS,
  }),
  defineAction({
    name: "post_job",
    description: "Create a job (draft or open). Open jobs of subscribed companies appear in candidate digests.",
    rest: { method: "POST", path: "/jobs", status: 201, operationId: "postJob" },
    mcp: { tool: "post_job", annotations: {} },
    input: T.JobCreate,
    output: T.Job,
    permission: "jobs.write",
    access: SUBSCRIPTION_ONLY,
  }),
  defineAction({
    name: "get_job",
    description: "One job with digest and click counts.",
    rest: { method: "GET", path: "/jobs/{job_id}", status: 200, operationId: "getJob" },
    mcp: { tool: "get_job", annotations: READ },
    input: z.strictObject({ job_id: T.JobId }),
    output: T.Job,
    permission: "jobs.read",
    access: ALL_ACCESS,
  }),
  defineAction({
    name: "update_job",
    description: "Edit a job or publish a draft (status open).",
    rest: { method: "PATCH", path: "/jobs/{job_id}", status: 200, operationId: "updateJob" },
    mcp: { tool: "update_job", annotations: {} },
    input: z.strictObject({ job_id: T.JobId, ...T.JobUpdate.shape }).refine(atLeastOne("job_id"), {
      message: "Send at least one field to change.",
    }),
    output: T.Job,
    permission: "jobs.write",
    access: SUBSCRIPTION_ONLY,
  }),
  defineAction({
    name: "close_job",
    description: "Close a job. It leaves digests and the X queue at once.",
    rest: { method: "POST", path: "/jobs/{job_id}/close", status: 200, operationId: "closeJob" },
    mcp: { tool: "close_job", annotations: { destructiveHint: true } },
    input: z.strictObject({ job_id: T.JobId }),
    output: T.Job,
    permission: "jobs.write",
    access: ALL_ACCESS,
  }),
  defineAction({
    name: "list_saved_searches",
    description: "Saved searches of this company.",
    rest: { method: "GET", path: "/saved-searches", status: 200, operationId: "listSavedSearches" },
    mcp: { tool: "list_saved_searches", annotations: READ },
    input: T.Empty,
    output: T.SavedSearchList,
    permission: "saved_searches.manage",
    access: ALL_ACCESS,
  }),
  defineAction({
    name: "create_saved_search",
    description: "Save a search. Current matches are marked as seen; daily alerts report only new ones.",
    rest: { method: "POST", path: "/saved-searches", status: 201, operationId: "createSavedSearch" },
    mcp: { tool: "create_saved_search", annotations: {} },
    input: T.SavedSearchCreate,
    output: T.SavedSearch,
    permission: "saved_searches.manage",
    access: SUBSCRIPTION_ONLY,
  }),
  defineAction({
    name: "update_saved_search",
    description: "Rename a saved search, change its filters or switch the daily alert.",
    rest: { method: "PATCH", path: "/saved-searches/{saved_search_id}", status: 200, operationId: "updateSavedSearch" },
    mcp: { tool: "update_saved_search", annotations: {} },
    input: z
      .strictObject({ saved_search_id: T.SavedSearchId, ...T.SavedSearchUpdate.shape })
      .refine(atLeastOne("saved_search_id"), { message: "Send at least one field to change." }),
    output: T.SavedSearch,
    permission: "saved_searches.manage",
    access: SUBSCRIPTION_ONLY,
  }),
  defineAction({
    name: "delete_saved_search",
    description: "Delete a saved search.",
    rest: { method: "DELETE", path: "/saved-searches/{saved_search_id}", status: 204, operationId: "deleteSavedSearch" },
    mcp: { tool: "delete_saved_search", annotations: { destructiveHint: true } },
    input: z.strictObject({ saved_search_id: T.SavedSearchId }),
    output: T.Empty,
    permission: "saved_searches.manage",
    access: ALL_ACCESS,
  }),
  defineAction({
    name: "get_webhook",
    description: "Webhook endpoint settings. The secret is shown only when it is set or rotated.",
    rest: { method: "GET", path: "/webhook", status: 200, operationId: "getWebhook" },
    mcp: { tool: "get_webhook", annotations: READ },
    input: T.Empty,
    output: T.Webhook,
    permission: "webhook.read",
    access: ALL_ACCESS,
  }),
  defineAction({
    name: "set_webhook",
    description: "Set the webhook URL, enable or disable it, or rotate the signing secret.",
    rest: { method: "PUT", path: "/webhook", status: 200, operationId: "setWebhook" },
    mcp: { tool: "set_webhook", annotations: { idempotentHint: true } },
    input: T.WebhookUpdate.refine(atLeastOne(""), { message: "Send at least one of url, enabled or rotate_secret." }),
    output: T.Webhook,
    permission: "webhook.write",
    access: ALL_ACCESS,
  }),
  defineAction({
    name: "test_webhook",
    description: "Send a signed ping event now and return the endpoint's answer.",
    rest: { method: "POST", path: "/webhook/test", status: 200, operationId: "testWebhook" },
    mcp: { tool: "test_webhook", annotations: {} },
    input: T.Empty,
    output: T.WebhookTestResult,
    permission: "webhook.write",
    access: ALL_ACCESS,
  }),
  defineAction({
    name: "get_usage",
    description: "Calls and x402 spend per day and action.",
    rest: { method: "GET", path: "/usage", status: 200, operationId: "getUsage" },
    mcp: { tool: "get_usage", annotations: READ },
    input: z.strictObject({ from: T.IsoDate.optional(), to: T.IsoDate.optional() }),
    output: T.Usage,
    permission: "usage.read",
    access: ["subscription", "pay_per_request", "none"],
  }),
  defineAction({
    name: "buy_usdc_month",
    description: "Pay 100 USDC on Base or Solana for 30 days of subscription access.",
    rest: { method: "POST", path: "/billing/usdc-month", status: 200, operationId: "buyUsdcMonth" },
    mcp: { tool: "buy_usdc_month", annotations: {} },
    input: T.Empty,
    output: T.UsdcMonthResult,
    permission: "billing.usdc",
    access: ALL_ACCESS,
    channels: ["rest", "mcp"],
    price: { usd: "100.00", payers: ["subscription", "pay_per_request"] },
    settle: "before_effect",
  }),
  defineAction({
    name: "search_jobs",
    description: "Search open crypto jobs (company jobs and the NextRole crawl). Jobs only, never people.",
    rest: { method: "GET", path: "/public/jobs", status: 200, operationId: "searchJobs" },
    mcp: { tool: "search_jobs", annotations: READ },
    input: z.strictObject({
      q: z.string().max(100).optional(),
      role: T.RoleKey.optional(),
      work_mode: z.enum(["remote", "city"]).optional(),
      city: z.string().max(80).optional(),
      salary_min: z.number().int().min(0).optional(),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .optional(),
      cursor: T.Cursor.optional(),
      limit: T.Limit20.optional(),
    }),
    output: T.PublicJobList,
    permission: "public",
    access: ["subscription", "pay_per_request", "none"],
  }),
] as const;

export type ActionName = (typeof ACTIONS)[number]["name"];

const BY_NAME = new Map<string, ActionDef>(ACTIONS.map((a) => [a.name, a as unknown as ActionDef]));

export function getAction(name: string): ActionDef | undefined {
  return BY_NAME.get(name);
}

// ---------------------------------------------------------------------------
// Виконання

/** Дія платна для цього актора, а платежу немає: REST/MCP відповідають 402 (lib/x402). */
export class PaymentRequired extends Error {
  constructor(
    readonly action: PaidAction,
    readonly usd: string,
    readonly settle: SettleTiming,
  ) {
    super(`payment required: ${action}`);
    this.name = "PaymentRequired";
  }
}

export interface PreparedAction {
  def: ActionDef;
  input: unknown;
  ctx: ActionContext;
  /** Ціна, якщо цей виклик оплачує x402; null = входить у доступ або безкоштовно. */
  payment: { action: PaidAction; usd: string; settle: SettleTiming } | null;
}

/** Платіж, який дав шлюз x402 після verify: id рядка x402_payments і адреса платника. */
export interface PaymentRef {
  id: string;
  payer: string | null;
}

/** Бронь виклику: квоту перевірено, рядок usage_events (якщо дія з квотою) уже стоїть. */
export interface Reservation {
  prepared: PreparedAction;
  /** Контекст з платником x402 (для гостя), яким пишеться облік і журнал. */
  ctx: ActionContext;
  usage: UsageRecord | null;
  /** id рядка usage_events, заброньованого до дії; null для дій без квоти. */
  usageId: number | null;
  /** Денна квота дії (для RateLimit-* і _meta["ncj/quota"]). */
  quota: QuotaState | null;
}

export interface ActionResult {
  output: unknown;
  status: number;
  /** Денна квота дії (для RateLimit-* і _meta["ncj/quota"]). */
  quota: QuotaState | null;
  headers: Record<string, string>;
}

/*
 * Кроки виконання однакові для всіх каналів (специфікація 7.4):
 *
 *   prepareAction  вхід, право, стан компанії, доступ, канал, чи є обробник (501);
 *                  нічого не пише. Кидає до будь-якої 402.
 *   reserve        квоти (атомарна бронь рядка usage_events). Для платної дії це
 *                  `validate` шлюзу x402: квоту перевірено ДО settle.
 *   run            обробник + перевірка виходу; облік і журнал НЕ пише. Для
 *                  before_response (пошук) це `effect` шлюзу; для before_effect
 *                  (знайомство, місяць USDC) `effect` теж run, і пише лише сам обробник.
 *   commit         облік і журнал одним пакетом, лише після вдалого settle.
 *   release        відмова після броні (settle не пройшов, обробник упав).
 *
 * Шлюз x402 (T9/T10):
 *   const prepared = prepareAction(name, input, ctx);           // 404/401/403/422/501
 *   let r: Reservation | undefined;
 *   const paid = gate.withPayment(prepared.payment.action, prepared.payment.settle, {
 *     validate: async (p) => { try { r = await reserve(prepared, { id: p.paymentId, payer: p.payer }); }
 *                              catch (e) { if (e instanceof ActionError) return e; throw e; } },
 *     effect: () => run(prepared),
 *   });
 *   const out = await paid({ payment, input: prepared.input, resource, context });
 *   out.kind === "ok" ? await commit(r!, out.value) : r && (await release(r, 402));
 */

/**
 * Усі перевірки до оплати й до дії: чи дія реалізована, вхід, право, стан
 * компанії, доступ, канал. Нічого не пише в базу.
 */
export function prepareAction(name: string, rawInput: unknown, ctx: ActionContext): PreparedAction {
  const def = getAction(name);
  if (!def) throw new ActionError("not_found", 404, "Unknown action.");
  // Раніше за будь-яку 402: за нереалізовану дію не можна взяти гроші.
  if (!def.handler) throw new ActionError("not_implemented", 501, "This action is not available yet.");
  if (def.channels && !def.channels.includes(ctx.channel)) {
    throw new ActionError("key_required", 401, "This action is available through the API with a key.");
  }

  const parsed = def.input.safeParse(rawInput ?? {});
  if (!parsed.success) throw validationError(parsed.error);

  if (def.permission !== "public") {
    assertCan(actorRole(ctx.actor), def.permission);
    const company = ctx.company;
    if (ctx.actor.kind === "member" || ctx.actor.kind === "agent") {
      if (!company) throw new ActionError("unauthorized", 401, "Sign in or send an API key.");
      if (company.status !== "active" && company.status !== "pending_review") {
        throw new ActionError("company_not_active", 403, companyInactiveText(company.status));
      }
      if (!def.access.includes(company.access)) {
        throw company.access === "none"
          ? new ActionError("company_not_active", 403, companyInactiveText(company.status))
          : new ActionError("subscription_required", 403, "This action needs a subscription.");
      }
      // Без підписки інтерфейс лише читає: платити x402 можна лише з API чи MCP.
      if (ctx.channel === "web" && company.access === "pay_per_request" && (!def.mcp.annotations.readOnlyHint || def.price)) {
        throw new ActionError("subscription_required", 403, "Subscribe to do this in the web app, or use the API.");
      }
    }
  }

  return { def, input: parsed.data, ctx, payment: paymentFor(def, ctx) };
}

function companyInactiveText(status: string): string {
  switch (status) {
    case "pending_review":
      return "Your application is under review. We review applications within 2 business days.";
    case "suspended":
      return "This company account is suspended.";
    case "rejected":
      return "This company application was rejected.";
    default:
      return "This company account is closed.";
  }
}

function paymentFor(def: ActionDef, ctx: ActionContext): PreparedAction["payment"] {
  if (!def.price || !def.settle) return null;
  const payer =
    ctx.actor.kind === "x402_guest"
      ? "x402_guest"
      : ctx.company?.access === "subscription"
        ? "subscription"
        : "pay_per_request";
  if (!def.price.payers.includes(payer)) return null;
  return { action: def.name as PaidAction, usd: def.price.usd, settle: def.settle };
}

/**
 * Квоти до дії (і до settle): атомарна бронь рядка usage_events для дії з квотою.
 * Платна дія без платежу → PaymentRequired; вичерпана квота → ActionError 429/403.
 */
export async function reserve(prepared: PreparedAction, payment: PaymentRef | null = null): Promise<Reservation> {
  const { def } = prepared;
  if (prepared.payment && !payment) {
    throw new PaymentRequired(prepared.payment.action, prepared.payment.usd, prepared.payment.settle);
  }
  const ctx: ActionContext =
    prepared.ctx.actor.kind === "x402_guest" && payment
      ? { ...prepared.ctx, actor: { kind: "x402_guest", payer: payment.payer, paymentId: payment.id } }
      : prepared.ctx;
  const usage = usageRecord(def, ctx, payment);
  const plan = quotaPlan(ctx.actor, ctx.company);

  if (def.quota && usage && plan) {
    const booked = await reserveUsage(ctx.db, usage, plan, def.quota, ctx.company?.subscription ?? null, ctx.now);
    if (!booked.ok) throw quotaError(booked.exceeded, plan);
    return { prepared, ctx, usage, usageId: booked.usageId, quota: booked.quotas[0] ?? null };
  }
  return { prepared, ctx, usage, usageId: null, quota: null };
}

/** Обробник і перевірка виходу за схемою. Облік і журнал не пише (це commit). */
export async function run(prepared: PreparedAction): Promise<HandlerResult<unknown>> {
  const { def } = prepared;
  if (!def.handler) throw new ActionError("not_implemented", 501, "This action is not available yet.");
  const result = await def.handler(prepared.ctx, prepared.input);
  const checked = def.output.safeParse(result.output);
  if (!checked.success) {
    console.error(`crm: output of ${def.name} does not match its schema`, checked.error.issues.slice(0, 5));
    throw new ActionError("internal", 500, "Something went wrong on our side. Try again later.");
  }
  return { ...result, output: checked.data };
}

/** Облік (usage_events) і журнал (audit_log) одним пакетом після успіху (і після settle). */
export async function commit(reservation: Reservation, result: HandlerResult<unknown>): Promise<ActionResult> {
  const { prepared, ctx, usage, usageId, quota } = reservation;
  const { def, input } = prepared;
  const status = result.status ?? def.rest.status;
  const writes: D1PreparedStatement[] = [];
  if (usageId !== null) {
    // Бронь уже записана зі статусом 200; оновлюємо, лише коли є що уточнити.
    if ((result.results ?? null) !== null || status !== 200) {
      writes.push(finishUsageStatement(ctx.db, usageId, status, result.results ?? null));
    }
  } else if (usage) {
    writes.push(usageStatement(ctx.db, { ...usage, status, results: result.results ?? null }, ctx.now));
  }
  const auditAction = result.audit?.action ?? def.audit;
  if (auditAction) {
    const target = result.audit?.target !== undefined ? result.audit.target : candidateOf(input);
    writes.push(auditStatement(ctx, { action: auditAction, target, meta: result.audit?.meta }));
  }
  if (writes.length) await ctx.db.batch(writes);
  return { output: result.output, status, quota, headers: quota ? rateLimitHeaders(quota) : {} };
}

/**
 * Відмова після броні. Платіж не пройшов (402): рядка обліку не лишається, наче
 * виклику не було. Інша помилка: рядок лишається з цим статусом і не рахується в квоту.
 */
export async function release(reservation: Reservation, status: number): Promise<void> {
  if (reservation.usageId === null) return;
  const { db } = reservation.ctx;
  if (status === 402) {
    await db.prepare("DELETE FROM usage_events WHERE id = ?").bind(reservation.usageId).run();
  } else {
    await finishUsageStatement(db, reservation.usageId, status, null).run();
  }
}

/**
 * Усі кроки для виклику без шлюзу x402 (інтерфейс, дії без ціни) або з уже
 * перевіреним і розрахованим платежем. Платна дія без платежу кидає PaymentRequired.
 */
export async function runAction(
  name: string,
  rawInput: unknown,
  ctx: ActionContext,
  opts: { payment?: PaymentRef } = {},
): Promise<ActionResult> {
  const prepared = prepareAction(name, rawInput, ctx);
  const reservation = await reserve(prepared, opts.payment ?? null);
  let result: HandlerResult<unknown>;
  try {
    result = await run(prepared);
  } catch (error) {
    await release(reservation, error instanceof ActionError ? error.status : 500);
    throw error;
  }
  return commit(reservation, result);
}

function candidateOf(input: unknown): string | null {
  const id = (input as { candidate_id?: unknown } | null)?.candidate_id;
  return typeof id === "string" ? id : null;
}

/** Рядок usage_events для цього виклику; null, коли актора не видно (публічна дія). */
function usageRecord(def: ActionDef, ctx: ActionContext, payment: PaymentRef | null): UsageRecord | null {
  let subject: QuotaSubject;
  if (ctx.actor.kind === "x402_guest") {
    if (!payment) return null;
    // Квота гостя за адресою платника; без адреси (фасилітатор не дав) за самим платежем.
    subject = { payer: payment.payer ?? `payment:${payment.id}` };
  } else if (ctx.company) {
    subject = { companyId: ctx.company.id };
  } else {
    return null;
  }
  return {
    subject,
    action: def.name,
    channel: ctx.channel,
    billing: payment ? "x402" : def.quota ? "included" : "free",
    apiKeyId: ctx.actor.kind === "agent" ? ctx.actor.keyId : null,
    memberUserId: ctx.actor.kind === "member" ? ctx.actor.userId : null,
    paymentId: payment?.id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Обробники T2–T3

async function getAccount(ctx: ActionContext): Promise<HandlerResult<T.Account>> {
  const company = ctx.company;
  if (!company) throw new ActionError("unauthorized", 401, "Sign in or send an API key.");
  const plan = quotaPlan(ctx.actor, company);
  const states = plan ? await quotaStates(ctx.db, { companyId: company.id }, plan, company.subscription, ctx.now) : [];
  const x402 = readX402Config(ctx.env);
  const prices: Record<string, string> = {};
  for (const a of ACTIONS) if ("price" in a && a.price) prices[a.name] = a.price.usd;

  return {
    output: {
      company: {
        company_id: company.id,
        name: company.name,
        kind: company.kind,
        status: company.status,
        domain_verified: company.domainVerified,
      },
      access: {
        mode: company.access,
        subscription_status: company.latestStatus,
        period_end: company.subscription?.periodEnd ? isoTime(company.subscription.periodEnd) : null,
        trial: company.plan === "trial",
      },
      quotas: quotasForAccount(states),
      x402: { enabled: x402.enabled, networks: x402.networks.map((n) => n.network), prices_usd: prices },
      key:
        ctx.actor.kind === "agent"
          ? { key_id: ctx.actor.keyId, name: ctx.actor.keyName, prefix: ctx.actor.keyPrefix }
          : null,
    },
  };
}

async function getCandidate(
  ctx: ActionContext,
  input: { candidate_id: string },
): Promise<HandlerResult<T.CandidateView>> {
  const company = ctx.company;
  if (!company) throw new ActionError("unauthorized", 401, "Sign in or send an API key.");
  const id = input.candidate_id;

  const [pipelineRes, introRes, contactRes] = await ctx.db.batch([
    ctx.db.prepare("SELECT stage, tags FROM pipeline WHERE company_id = ? AND user_id = ?").bind(company.id, id),
    ctx.db
      .prepare(
        `SELECT ${INTRO_COLUMNS} FROM intros WHERE company_id = ? AND user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .bind(company.id, id),
    // Контакт лишається, навіть коли людина потім сховалась (знімок у мить згоди).
    ctx.db
      .prepare(
        `SELECT ${INTRO_COLUMNS} FROM intros
          WHERE company_id = ? AND user_id = ? AND status IN ('accepted', 'direct') AND contact_value IS NOT NULL
          ORDER BY COALESCE(responded_at, created_at) DESC LIMIT 1`,
      )
      .bind(company.id, id),
  ]);
  const pipeline = (pipelineRes.results[0] as { stage: T.Stage; tags: string } | undefined) ?? null;
  const intro = (introRes.results[0] as IntroRow | undefined) ?? null;
  const contactRow = (contactRes.results[0] as IntroRow | undefined) ?? null;
  const contact = contactRow ? contactFromIntro(contactRow) : null;

  if (await isVisibleTo(ctx.db, id, company.id)) {
    const rows = (await loadCandidates(ctx.db, [id], company.id)).get(id);
    if (rows) {
      return { output: projectProfile(rows, { now: ctx.now, intro: intro ? projectIntro(intro) : null, contact }) };
    }
  }
  if (pipeline) return { output: projectHidden(id, pipeline, contact) };
  throw new ActionError("candidate_not_available", 404, "This candidate is not available.");
}
