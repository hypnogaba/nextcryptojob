import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { getAction } from "@/lib/crm/actions";
import { crmBase } from "@/lib/crm/context";
import { ActionError } from "@/lib/crm/types";
import { FEEDBACK_REASONS, type FeedbackReason, recordFeedback } from "@/lib/digest/feedback";
import { recentSentJobs } from "@/lib/digest/history";
import { ROLES } from "@/lib/card/roles";
import { inferRoles } from "@/lib/roles/infer";
import { jobsDb } from "@/lib/jobs-db";
import { CURRENCIES, parsePlace, whereFromMode } from "@/lib/onboarding/place";
import { loadAnswers, placeFields, TARGET_MAX, targetFields, updateBrief } from "@/lib/onboarding/store";
import { JOBS_VIEW_HTML, JOBS_VIEW_URI } from "@/lib/mcp-ui/jobs-view";
import { MCP_APP_MIME } from "@/lib/mcp-ui/app-shell";
import { readBridge, type BridgedUser } from "@/lib/oauth/bridge";
import { CONNECTOR_PATH } from "@/lib/oauth/config";
import { errorResponse } from "@/lib/x402/http";
import { announceOnly, callTool, MCP_HOSTNAMES, type McpSession } from "./mcp";
import type { ToolResult } from "@/lib/x402/mcp";

/**
 * Особистий MCP людини для Claude, ChatGPT та інших помічників: POST https://nextcryptojob.xyz/mcp/me.
 *
 * Вхід OAuth 2.1 робить worker.ts (lib/oauth): сюди запит доходить лише з людиною в заголовках
 * мосту і секретом Worker. Без них 401 (readBridge).
 *
 * Інструменти:
 * - search_jobs: той самий публічний пошук, що /mcp і REST (реєстр дій), з картками;
 * - get_my_matches: що добірка вже надіслала людині, з «чому ти» і 👍/👎, з картками;
 * - get_my_brief: що людина шукає (її слова, ролі, віддалено чи місто, найменша зарплата);
 * - update_my_brief: змінити слова, віддалено чи місто, зарплату. Ролі лише на сайті: вони
 *   змінюють бал людини, і там вона бачить, що це означає;
 * - rate_job: 👍/👎 вакансії з її добірки (як кнопки в листі), далі добірка це враховує.
 *
 * Тексти (листи, пояснення) пише помічник людини на її підписці: нам це нічого не коштує.
 */

/** Скільки разів на хвилину одна людина може смикати інструменти (RL_WEB, як сайт). */
const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const MATCHES_DEFAULT = 15;
const MATCHES_MAX = 50;

const SITE = "https://nextcryptojob.xyz";

type Ctx = { user: BridgedUser; requestId: string; ip: string };

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

function fail(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function ok(data: Record<string, unknown>, summary?: string): ToolResult {
  return {
    structuredContent: data,
    content: [{ type: "text", text: summary ? `${summary}\n\n${JSON.stringify(data)}` : JSON.stringify(data) }],
  };
}

async function burst(ctx: Ctx): Promise<void> {
  const env = crmBase().env as unknown as { RL_WEB?: RateLimit };
  if (!env.RL_WEB) return;
  const { success } = await env.RL_WEB.limit({ key: `connector:${ctx.user.userId}` });
  if (!success) throw new ActionError("rate_limited", 429, "Too many requests. Wait a minute and try again.");
}

// ---------------------------------------------------------------------------
// Схеми

export const MatchesInput = z.strictObject({
  limit: z.number().int().min(1).max(MATCHES_MAX).optional().describe(`How many recent matches, newest first (default ${MATCHES_DEFAULT}).`),
});

export const UpdateBriefInput = z
  .strictObject({
    job_words: z.string().min(2).max(TARGET_MAX).optional().describe("The job the person wants, in their own words."),
    work: z.enum(["remote", "city", "both"]).optional().describe("Remote only, one city only, or both."),
    city: z.string().max(80).optional().describe("City name, needed when work is city or both."),
    salary_min: z.number().int().min(0).max(10_000_000).nullable().optional().describe("Lowest yearly salary. null removes it."),
    currency: z.enum(CURRENCIES).optional().describe("Currency of salary_min (default USD)."),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Give at least one field to change." });

export const RateInput = z.strictObject({
  ref: z.string().max(80).describe("The ref of a job from get_my_matches."),
  vote: z.enum(["up", "down"]),
  reason: z
    .enum(Object.keys(FEEDBACK_REASONS) as [FeedbackReason, ...FeedbackReason[]])
    .optional()
    .describe("Only for vote down: why the job is wrong for the person."),
});

// ---------------------------------------------------------------------------
// Обробники (експортовано для тестів)

export async function myBrief(userId: string): Promise<ToolResult> {
  const d = crmBase().db;
  const a = await loadAnswers(d, userId);
  const done = a.step === "done";
  const brief = {
    job_words: a.targetText || null,
    roles: a.roles,
    own_role: a.roleText || null,
    work: whereFromMode(a.remoteMode),
    city: a.city,
    salary_min: a.salaryMin,
    currency: a.salaryCurrency,
    finished: done,
    edit_on_site: `${SITE}/welcome`,
  };
  return ok(brief, done ? undefined : `The brief is not finished yet. The person can finish it at ${SITE}/welcome.`);
}

export async function myMatches(userId: string, input: z.output<typeof MatchesInput>): Promise<ToolResult> {
  const base = crmBase();
  // Вузьке читання: лише останні N надісланих і їхні подробиці (не вся сторінка /jobs).
  const recent = await recentSentJobs(base.db, jobsDb(), userId, input.limit ?? MATCHES_DEFAULT);
  if (recent === null) return fail("We could not read your matches right now. Try again in a minute.");
  const votes = await votesFor(base.db, userId, recent.map((j) => j.ref));
  const matches = recent.map((j) => ({
    ref: j.ref,
    date: j.localDate,
    state: j.state,
    title: j.details?.title ?? (j.state === "gone" ? "Job no longer listed" : "Details unavailable right now"),
    company: j.details?.company ?? "",
    location: j.details?.location ?? null,
    salary: j.details?.salary ?? j.details?.salaryEstimate ?? null,
    url: j.details?.url ? new URL(j.details.url, SITE).toString() : null,
    via: j.details?.via ?? null,
    why: j.why,
    vote: votes.get(j.ref) ?? null,
  }));
  const unavailable = matches.some((m) => m.state === "unavailable")
    ? " Some job details could not be read right now; they are not closed, ask again later."
    : "";
  const summary =
    matches.length === 0
      ? "No matches sent yet. New matches come once a day by email or Telegram after the brief is finished."
      : `${matches.length} recent matches.${unavailable} Link each job by its url exactly as given and name the board in via as the source.`;
  return ok({ matches }, summary);
}

async function votesFor(d: D1Database, userId: string, refs: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(refs)].slice(0, 90);
  if (unique.length === 0) return new Map();
  const { results } = await d
    .prepare(`SELECT job_ref, vote FROM job_feedback WHERE user_id = ? AND job_ref IN (${unique.map(() => "?").join(",")})`)
    .bind(userId, ...unique)
    .all<{ job_ref: string; vote: string }>();
  return new Map(results.map((r) => [r.job_ref, r.vote]));
}

export async function changeBrief(userId: string, input: z.output<typeof UpdateBriefInput>): Promise<ToolResult> {
  const d = crmBase().db;
  const a = await loadAnswers(d, userId);
  if (a.step !== "done") return fail(`Finish the brief on the site first: ${SITE}/welcome`);

  const fields: Parameters<typeof updateBrief>[2] = {};
  // Слова й ролі йдуть парою (сайт веде на крок ролей, бот читає ролі зі слів). Ролі тут не змінюємо:
  // вони змінюють бал людини. Якщо нові слова вказують на інші ролі, кажемо це прямо.
  let rolesNote = "";
  if (input.job_words !== undefined) {
    const words = input.job_words.trim().replace(/\s+/g, " ");
    if (words.length < 2) return fail("Say in a few words what job the person wants.");
    Object.assign(fields, targetFields(words));
    const suggested = inferRoles(words);
    const same = suggested.length === 0 || (suggested.length === a.roles.length && suggested.every((r) => a.roles.includes(r)));
    if (!same) {
      const names = (keys: readonly string[]) => keys.map((k) => ROLES[k as keyof typeof ROLES]?.name ?? k).join(", ");
      rolesNote =
        ` The daily list still picks jobs by the saved roles (${names(a.roles) || "none"}). ` +
        `The new words point to ${names(suggested)}. To switch roles, open ${SITE}/welcome: roles also change the person's score.`;
    }
  }
  const touchesPlace = input.work !== undefined || input.city !== undefined || input.salary_min !== undefined || input.currency !== undefined;
  if (touchesPlace) {
    const salary = input.salary_min === undefined ? a.salaryMin : input.salary_min;
    const parsed = parsePlace({
      where: input.work ?? whereFromMode(a.remoteMode) ?? "remote",
      city: input.city ?? a.city ?? "",
      salary: salary === null ? "" : String(salary),
      currency: input.currency ?? a.salaryCurrency ?? "USD",
    });
    if (!parsed.ok) return fail(Object.values(parsed.errors).join(" "));
    Object.assign(fields, placeFields(parsed.place));
  }
  await updateBrief(d, userId, fields);
  return myBrief(userId).then((r) => ({
    ...r,
    content: [{ type: "text" as const, text: `Saved. The next daily list uses the new brief.${rolesNote}\n\n${JSON.stringify(r.structuredContent)}` }],
  }));
}

export async function rate(userId: string, input: z.output<typeof RateInput>): Promise<ToolResult> {
  const base = crmBase();
  const res = await recordFeedback(base.db, jobsDb(), userId, input.ref, input.vote, input.vote === "down" ? (input.reason ?? null) : null);
  if (res === "bad_ref" || res === "unknown_job") return fail("You can rate only jobs from your own matches (get_my_matches).");
  return text(input.vote === "up" ? "Saved 👍. More jobs like this one." : "Saved 👎. Fewer jobs like this one.");
}

// ---------------------------------------------------------------------------
// Сервер

async function guard(ctx: Ctx, run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    await burst(ctx);
    return await run();
  } catch (error) {
    if (error instanceof ActionError) return fail(error.message);
    console.error("mcp/me: unexpected error", {
      requestId: ctx.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return fail("Something went wrong on our side. Try again later.");
  }
}

const UI = { ui: { resourceUri: JOBS_VIEW_URI } };

export function buildConnectorServer(ctx: Ctx): McpServer {
  const server = new McpServer(
    { name: "nextcryptojob", title: "NextCryptoJob", version: "1.0.0", websiteUrl: SITE },
    {
      instructions:
        "NextCryptoJob finds crypto jobs for one person and sends up to 5 matches a day. Use get_my_brief first to know what they want. " +
        "Link every job by its url exactly as returned. Write cover letters and messages in the person's own voice from their own words; never invent experience.",
    },
  );

  server.registerResource(
    "jobs-view",
    JOBS_VIEW_URI,
    { title: "Job cards", mimeType: MCP_APP_MIME, _meta: { ui: { prefersBorder: false } } },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: MCP_APP_MIME, text: JOBS_VIEW_HTML, _meta: { ui: { prefersBorder: false } } }] }),
  );

  const search = getAction("search_jobs");
  if (search) {
    server.registerTool(
      "search_jobs",
      {
        title: "Search crypto jobs",
        description: search.description,
        // Як на /mcp: схему лише оголошуємо, перевіряє реєстр (validation_failed з полями).
        inputSchema: announceOnly(search.input),
        annotations: READ,
        _meta: UI,
      },
      async (args: unknown) =>
        guard(ctx, () => {
          const session: McpSession = { base: crmBase(ctx.requestId), requestId: ctx.requestId, agent: null, ip: ctx.ip };
          return callTool(session, search, args, undefined);
        }),
    );
  }

  server.registerTool(
    "get_my_matches",
    {
      title: "Get my job matches",
      description:
        "The jobs NextCryptoJob already sent this person in their daily lists, newest first, each with why it fits. Use it when they ask about their matches, what was sent today, or to pick a job to apply for.",
      inputSchema: MatchesInput,
      annotations: READ,
      _meta: UI,
    },
    async (args: unknown) =>
      guard(ctx, () => myMatches(ctx.user.userId, args as z.output<typeof MatchesInput>)),
  );

  server.registerTool(
    "get_my_brief",
    {
      title: "Get my job brief",
      description: "What job this person wants: their own words, roles, remote or city, and lowest salary. Read it before searching or writing for them.",
      inputSchema: z.strictObject({}),
      annotations: READ,
    },
    async () => guard(ctx, () => myBrief(ctx.user.userId)),
  );

  server.registerTool(
    "update_my_brief",
    {
      title: "Update my job brief",
      description:
        "Change what job this person wants: their words, remote or city, city, lowest salary. Only fields given are changed. Roles are changed on the site, because they change the person's score.",
      inputSchema: UpdateBriefInput,
      annotations: WRITE,
    },
    async (args: unknown) =>
      guard(ctx, () => changeBrief(ctx.user.userId, args as z.output<typeof UpdateBriefInput>)),
  );

  server.registerTool(
    "rate_job",
    {
      title: "Rate a job match",
      description: "Thumbs up or down on a job from get_my_matches. Future daily lists use it. Give a reason with a thumbs down when the person said why.",
      inputSchema: RateInput,
      annotations: WRITE,
    },
    async (args: unknown) =>
      guard(ctx, () => rate(ctx.user.userId, args as z.output<typeof RateInput>)),
  );

  return server;
}

const handler = createMcpHandler(
  ({ authInfo }) => {
    const ctx = authInfo?.extra?.ctx as Ctx | undefined;
    if (!ctx) throw new Error("mcp/me: request came without a person");
    return buildConnectorServer(ctx);
  },
  { route: CONNECTOR_PATH, allowedHostnames: MCP_HOSTNAMES, allowedOriginHostnames: MCP_HOSTNAMES },
);

/** Маршрут app/mcp/me: людину дає лише міст від worker.ts, інакше 401. */
export async function handleConnector(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  const env = crmBase().env as unknown as { CONNECTOR_BRIDGE_SECRET?: string };
  const user = readBridge(request, env.CONNECTOR_BRIDGE_SECRET);
  if (!user) {
    return errorResponse(new ActionError("unauthorized", 401, "Connect from your AI app to sign in."), requestId);
  }
  const ctx: Ctx = { user, requestId, ip: request.headers.get("cf-connecting-ip") ?? "unknown" };
  const response = await handler.fetch(request, {
    authInfo: { token: "connector", clientId: user.clientId ?? "connector", scopes: user.scopes, extra: { ctx } },
  });
  const headers = new Headers(response.headers);
  headers.set("X-Request-Id", requestId);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
