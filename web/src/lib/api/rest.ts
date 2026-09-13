import { z } from "zod";
import { ACTIONS, type ActionDef } from "@/lib/crm/actions";
import { crmBase, resolveActor, type ActionContext, type ContextBase } from "@/lib/crm/context";
import { executeAction } from "@/lib/crm/execute";
import { can } from "@/lib/crm/permissions";
import { checkRequestBurst } from "@/lib/crm/quotas";
import { ActionError } from "@/lib/crm/types";
import { errorResponse, readPaymentSignature, restResponse } from "@/lib/x402/http";

/**
 * REST API компаній: https://nextcryptojob.xyz/api/v1 (docs/api/openapi.yaml, специфікація 7.1).
 *
 * Маршрути не пишуться руками: кожна дія реєстру (lib/crm/actions.ts) має метод і
 * шлях REST, і цей роутер зіставляє з ними запит. Тож REST, MCP і інтерфейс
 * мають одні й ті самі дії, а нова дія реєстру відразу має свій маршрут.
 *
 * Запит → вхід дії: параметри шляху + параметри запиту + поля тіла JSON, злиті в
 * один об'єкт (як вхід інструмента MCP). Ліміт сплесків іде першим, до тіла й до D1;
 * далі актор (ключ API; без ключа гість x402 там, де гостю можна; публічний search_jobs
 * без входу) і executeAction.
 */

export const API_PREFIX = "/api/v1";
/** Більшого тіла жодна дія не приймає (найбільше: вакансія з описом на 5 000 символів). */
const MAX_BODY_BYTES = 64 * 1024;
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

interface Route {
  def: ActionDef;
  pattern: RegExp;
  params: string[];
}

const ROUTES: Route[] = ACTIONS.map((action) => {
  const def = action as unknown as ActionDef;
  const params: string[] = [];
  const source = def.rest.path.replace(/\{([a-z_]+)\}/g, (_, name: string) => {
    params.push(name);
    return "([^/]+)";
  });
  return { def, pattern: new RegExp(`^${source}$`), params };
});

/** Типи параметрів запиту з JSON-схеми входу: рядок з адреси стає числом чи булевим. */
const queryTypes = new Map<string, Map<string, string>>();

function typesOf(def: ActionDef): Map<string, string> {
  let types = queryTypes.get(def.name);
  if (!types) {
    types = new Map();
    const json = z.toJSONSchema(def.input, { io: "input", unrepresentable: "any" }) as {
      properties?: Record<string, { type?: string | string[] }>;
    };
    for (const [name, prop] of Object.entries(json.properties ?? {})) {
      const type = Array.isArray(prop.type) ? prop.type.find((t) => t !== "null") : prop.type;
      if (type) types.set(name, type);
    }
    queryTypes.set(def.name, types);
  }
  return types;
}

function coerce(value: string, type: string | undefined): unknown {
  if ((type === "integer" || type === "number") && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (type === "boolean" && (value === "true" || value === "false")) return value === "true";
  return value;
}

const invalidBody = (message: string) =>
  new ActionError("validation_failed", 422, "Some fields are not valid.", { fields: { "(body)": message } });

/** Тіло не більше MAX_BODY_BYTES байтів: Content-Length одразу, потік читаємо лише до межі. */
async function readText(request: Request): Promise<string> {
  const tooLarge = () => invalidBody("The request body is too large.");
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) throw tooLarge();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidBody("The request body is not valid UTF-8.");
  }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await readText(request);
  if (!text.trim()) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw invalidBody("The request body is not valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalidBody("Send a JSON object.");
  return body as Record<string, unknown>;
}

function match(pathname: string): { route: Route; params: Record<string, string> }[] {
  const found: { route: Route; params: Record<string, string> }[] = [];
  for (const route of ROUTES) {
    const m = route.pattern.exec(pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    route.params.forEach((name, i) => (params[name] = decodeURIComponent(m[i + 1])));
    found.push({ route, params });
  }
  return found;
}

/** Контекст публічної дії (search_jobs): без входу й без компанії. */
function publicContext(base: ContextBase, requestId: string): ActionContext {
  return {
    db: base.db,
    env: base.env,
    channel: "rest",
    requestId,
    now: new Date(),
    actor: { kind: "x402_guest", payer: null, paymentId: null },
    company: null,
  };
}

async function dispatch(request: Request, requestId: string): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) || "/" : url.pathname;
  let candidates: ReturnType<typeof match>;
  try {
    candidates = match(pathname.replace(/\/+$/, "") || "/");
  } catch {
    candidates = []; // зіпсоване %-кодування в шляху
  }
  if (candidates.length === 0) throw new ActionError("not_found", 404, "There is no such endpoint.");
  // Сталий шлях важливіший за шаблон: /candidates/search не є профілем кандидата "search".
  const exact = candidates.filter((c) => c.route.params.length === 0);
  if (exact.length > 0) candidates = exact;
  const hit = candidates.find((c) => c.route.def.rest.method === request.method);
  if (!hit) {
    const allowed = candidates.map((c) => c.route.def.rest.method).join(", ");
    return errorResponse(
      new ActionError("not_found", 405, `This endpoint does not accept ${request.method}. Use ${allowed}.`),
      requestId,
      { Allow: allowed },
    );
  }
  const { def } = hit.route;

  // Сплески ДО тіла й ключа: зайвий запит не читає ні тіла, ні D1.
  const base = crmBase(requestId);
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const authorization = request.headers.get("authorization");
  await checkRequestBurst(base.env, { authorization, ip, scope: def.permission === "public" ? "public" : "guest" });

  const query: Record<string, unknown> = {};
  const types = typesOf(def);
  for (const [key, value] of url.searchParams) if (!(key in query)) query[key] = coerce(value, types.get(key));
  const body = BODY_METHODS.has(request.method) ? await readBody(request) : {};
  for (const [name, value] of Object.entries(hit.params)) {
    if (name in body && body[name] !== value) {
      throw new ActionError("validation_failed", 422, "Some fields are not valid.", {
        fields: { [name]: "This value comes from the URL path. Leave it out of the body or send the same value." },
      });
    }
  }
  const input = { ...query, ...body, ...hit.params };

  const payment = readPaymentSignature(request);
  const ctx: ActionContext =
    def.permission === "public"
      ? publicContext(base, requestId)
      : await resolveActor(base, {
          channel: "rest",
          authorization,
          // Без ключа гість x402 лише там, де гостю можна (пошук): так він дізнається ціну з 402.
          hasPayment: payment !== undefined || can("x402_guest", def.permission),
        });

  const outcome = await executeAction(def.name, input, ctx, { payment, resourceUrl: `${url.origin}${url.pathname}` });
  return restResponse(outcome, requestId);
}

/** Точка входу маршруту app/api/v1/[...path]. */
export async function handleRest(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return await dispatch(request, requestId);
  } catch (error) {
    if (error instanceof ActionError) return errorResponse(error, requestId);
    console.error("api: unexpected error", { requestId, error: error instanceof Error ? error.message : String(error) });
    return errorResponse(new ActionError("internal", 500, "Something went wrong on our side. Try again later."), requestId);
  }
}
