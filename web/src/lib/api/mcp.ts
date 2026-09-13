import { McpServer, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import type { z } from "zod";
import { ACTIONS, type ActionDef } from "@/lib/crm/actions";
import { crmBase, resolveActor, type ActionContext, type ContextBase } from "@/lib/crm/context";
import { executeAction } from "@/lib/crm/execute";
import { can } from "@/lib/crm/permissions";
import { checkBurst, checkRequestBurst } from "@/lib/crm/quotas";
import { ActionError } from "@/lib/crm/types";
import { errorResponse } from "@/lib/x402/http";
import { mcpError, mcpResult, readPaymentMeta, type ToolResult } from "@/lib/x402/mcp";

/**
 * MCP-сервер для агентів компаній: POST https://nextcryptojob.xyz/mcp
 * (docs/api/mcp-tools.md, специфікація 7.2). Streamable HTTP без стану:
 * createMcpHandler з `agents/mcp/server` (MCP SDK v2) будує новий McpServer на
 * кожен запит; McpAgent застарів і не потрібен.
 *
 * Інструменти беруться з реєстру дій (той самий, що в REST), тож вхід, вихід,
 * права, ціни й квоти в них ті самі: structuredContent = тіло успішної відповіді REST.
 * - З ключем (`Authorization: Bearer ncj_live_…`) видно всі 28 інструментів;
 *   ті, що потребують підписки, відповідають помилкою subscription_required, а не зникають.
 * - Без ключа лише search_jobs (безкоштовно) і search_candidates (x402).
 * - Хибний або відкликаний ключ: HTTP 401 з тим самим тілом помилки, що в REST.
 *
 * Вхід SDK не перевіряє (схему лише оголошує в tools/list): перевіряє реєстр, і
 * невалідний вхід дає ту саму помилку validation_failed з `details.fields`, що REST 422.
 * SDK v2 усе одно віддав би її результатом інструмента з isError, а не помилкою
 * протоколу -32602, тільки текстом без полів.
 */

export const MCP_ROUTE = "/mcp";
/** Хости, з яких приймаємо MCP (захист від DNS rebinding): прод, адреса workers.dev, локальна розробка. */
export const MCP_HOSTNAMES = ["nextcryptojob.xyz", "nextcryptojob.hypnogaba.workers.dev", "localhost", "127.0.0.1"];

const SERVER_INFO = { name: "nextcryptojob", version: "1.0.0" };

/** Усе, що інструменти одного HTTP-запиту знають про виклик. */
interface McpSession {
  base: ContextBase;
  requestId: string;
  /** Контекст ключа API; null для гостя без ключа. */
  agent: ActionContext | null;
  ip: string;
}

/** Інструменти, які бачить актор: з ключем усі, без ключа лише публічні й доступні гостю x402. */
export function toolsFor(withKey: boolean): ActionDef[] {
  const all = ACTIONS as unknown as ActionDef[];
  return withKey ? all : all.filter((def) => def.permission === "public" || can("x402_guest", def.permission));
}

/** Схема для tools/list без перевірки на боці SDK: перевіряє реєстр (див. вище). */
function announceOnly(schema: z.ZodType): StandardSchemaWithJSON {
  const standard = schema["~standard"] as unknown as StandardSchemaWithJSON["~standard"];
  return { "~standard": { ...standard, validate: (value: unknown) => ({ value }) } } as StandardSchemaWithJSON;
}

function guestContext(session: McpSession, now: Date): ActionContext {
  return {
    db: session.base.db,
    env: session.base.env,
    channel: "mcp",
    requestId: session.requestId,
    now,
    actor: { kind: "x402_guest", payer: null, paymentId: null },
    company: null,
  };
}

async function callTool(session: McpSession, def: ActionDef, args: unknown, meta: Record<string, unknown> | undefined): Promise<ToolResult> {
  const now = new Date();
  const ctx: ActionContext = session.agent ? { ...session.agent, now } : guestContext(session, now);
  try {
    // Кожен HTTP-запит уже пройшов ліміт сплесків (handleMcp). Платний інструмент гостя ще й
    // у межі гостя x402 (RL_IP, 10/хв на IP), як REST-пошук без ключа.
    if (!session.agent && def.permission !== "public") await checkBurst(ctx.env, ctx.actor, session.ip);
    const outcome = await executeAction(def.name, args ?? {}, ctx, {
      payment: readPaymentMeta(meta),
      resourceUrl: `mcp://tool/${def.mcp.tool}`,
    });
    return mcpResult(outcome, session.requestId);
  } catch (error) {
    if (error instanceof ActionError) return mcpError(error, session.requestId);
    console.error("mcp: unexpected error", {
      requestId: session.requestId,
      tool: def.mcp.tool,
      error: error instanceof Error ? error.message : String(error),
    });
    return mcpError(new ActionError("internal", 500, "Something went wrong on our side. Try again later."), session.requestId);
  }
}

/** Новий McpServer з інструментами під актора цього запиту. */
export function buildServer(session: McpSession): McpServer {
  const server = new McpServer(SERVER_INFO);
  for (const def of toolsFor(session.agent !== null)) {
    server.registerTool(
      def.mcp.tool,
      {
        description: def.description,
        inputSchema: announceOnly(def.input),
        outputSchema: def.output as unknown as StandardSchemaWithJSON,
        annotations: def.mcp.annotations,
      },
      async (args: unknown, extra) => callTool(session, def, args, extra.mcpReq._meta as Record<string, unknown> | undefined),
    );
  }
  return server;
}

const handler = createMcpHandler(
  ({ authInfo }) => {
    const session = authInfo?.extra?.session as McpSession | undefined;
    if (!session) throw new Error("mcp: request came without a session");
    return buildServer(session);
  },
  { route: MCP_ROUTE, allowedHostnames: MCP_HOSTNAMES, allowedOriginHostnames: MCP_HOSTNAMES },
);

/**
 * Відповідь на хибний чи відкликаний ключ. Без resource_metadata: OAuth у нас немає. Клієнти на
 * MCP TypeScript SDK з підтримкою OAuth на будь-який 401 усе одно пробують
 * /.well-known/oauth-protected-resource (заголовок цього не вимикає), отримують 404 і показують
 * помилку входу; клієнт без OAuth показує наше тіло помилки (docs/DECISIONS.md, 13.09).
 */
const WWW_AUTHENTICATE = 'Bearer realm="nextcryptojob", error="invalid_token", error_description="Send a valid API key: Authorization: Bearer ncj_live_..."';

/** Точка входу маршруту app/mcp: ліміт сплесків і ключ перевіряються до MCP, хибний ключ дає HTTP 401. */
export async function handleMcp(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return await serveMcp(request, requestId);
  } catch (error) {
    if (error instanceof ActionError) return errorResponse(error, requestId);
    // Збій D1 чи ще щось неочікуване: те саме JSON-тіло помилки, що в REST, а не сторінка 500.
    console.error("mcp: unexpected error", { requestId, error: error instanceof Error ? error.message : String(error) });
    return errorResponse(new ActionError("internal", 500, "Something went wrong on our side. Try again later."), requestId);
  }
}

async function serveMcp(request: Request, requestId: string): Promise<Response> {
  const base = crmBase(requestId);
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const authorization = request.headers.get("authorization")?.trim();
  let agent: ActionContext | null = null;
  if (request.method !== "OPTIONS") {
    // Кожен запит, і initialize, і tools/list: з ключем у RL_API за ключем, без ключа в RL_PUBLIC за IP.
    await checkRequestBurst(base.env, { authorization, ip, scope: "public" });
    if (authorization) {
      try {
        agent = await resolveActor(base, { channel: "mcp", authorization });
      } catch (error) {
        if (!(error instanceof ActionError)) throw error;
        return errorResponse(error, requestId, error.status === 401 ? { "WWW-Authenticate": WWW_AUTHENTICATE } : {});
      }
    }
  }
  const session: McpSession = { base, requestId, agent, ip };
  const response = await handler.fetch(request, {
    authInfo: {
      token: "ncj",
      clientId: agent?.actor.kind === "agent" ? agent.actor.keyId : "guest",
      scopes: [],
      extra: { session },
    },
  });
  const headers = new Headers(response.headers);
  headers.set("X-Request-Id", requestId);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
