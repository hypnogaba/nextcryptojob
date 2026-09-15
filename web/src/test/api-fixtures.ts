import { readFileSync } from "node:fs";
import { Validator } from "@cfworker/json-schema";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { parse } from "yaml";
import type { CrmEnv } from "@/lib/crm/context";
import { clearResourceServerCache } from "@/lib/x402/server";
import { crmDb } from "./crm-fixtures";
import { harness, resetHarness } from "./harness";
import { introEnv, PAYER, stubNetwork, type Network } from "./intro-fixtures";
import type { TestDb } from "./sqlite-d1";

/**
 * REST і MCP у тестах через справжні маршрути (app/api/v1/[...path], app/mcp) на
 * SQLite з усіма міграціями. Мережа на заглушці: Bot API, пошта і фасилітатор x402
 * (x402.org у розробці: /supported, /verify, /settle, лічильники в Network).
 * Тест підключає замінники так:
 *
 *   vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
 *   vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
 */

export const ORIGIN = "https://nextcryptojob.xyz";

/** Свіжа база, оточення Worker з адресами отримувача x402 і заглушка мережі. */
export function setupApi(env: Partial<CrmEnv> = {}): { db: TestDb; net: Network } {
  const net = stubNetwork();
  resetHarness({ ...(introEnv(net) as object), ...(env as object) });
  // Усі міграції з db/migrations (як у коментарі вгорі), а не лише накочені на прод:
  // код, що чекає нової колонки, тестується на схемі, яку він потребує.
  const { raw, d1 } = crmDb();
  harness.raw = raw;
  harness.env.DB = d1;
  clearResourceServerCache();
  return { db: { raw: harness.raw, d1: harness.env.DB }, net };
}

type Handler = (request: Request) => Promise<Response>;

/** Розібраний JSON відповіді: тест сам знає її форму, тож поля читаються без приведень. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- вільне читання JSON лише в тестах
export type Json = any;

export interface ApiResponse<T = Json> {
  status: number;
  headers: Headers;
  body: T;
}

export interface RestOptions {
  key?: string;
  body?: unknown;
  /** Сире тіло (для перевірки розбору). */
  raw?: string;
  payment?: string;
  headers?: Record<string, string>;
}

/** Виклик REST: `rest(POST, "POST", "/candidates/search", { key, body })`. */
export async function rest(handler: Handler, method: string, path: string, o: RestOptions = {}): Promise<ApiResponse> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.key) headers.authorization = `Bearer ${o.key}`;
  if (o.payment) headers["payment-signature"] = o.payment;
  let body: string | undefined = o.raw;
  if (o.body !== undefined) {
    body = JSON.stringify(o.body);
    headers["content-type"] = "application/json";
  }
  const res = await handler(new Request(`${ORIGIN}/api/v1${path}`, { method, headers, body }));
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

let rpcId = 0;

/** Один JSON-RPC запит до /mcp; відповідь SSE або JSON розбирається в об'єкт повідомлення. */
export async function mcp(
  handler: Handler,
  method: string,
  params: Record<string, unknown> = {},
  o: { key?: string; headers?: Record<string, string> } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = {
    host: "nextcryptojob.xyz",
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
    ...(o.headers ?? {}),
  };
  if (o.key) headers.authorization = `Bearer ${o.key}`;
  const res = await handler(
    new Request(`${ORIGIN}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) }),
  );
  const text = await res.text();
  const data = text.includes("data: ") ? text.split("\n").find((l) => l.startsWith("data: "))!.slice(6) : text;
  return { status: res.status, headers: res.headers, body: data ? JSON.parse(data) : null };
}

/** Результат tools/call. */
export async function callTool(
  handler: Handler,
  name: string,
  args: Record<string, unknown>,
  o: { key?: string; payment?: PaymentPayload } = {},
): Promise<{ isError?: boolean; structuredContent?: Json; content: { type: string; text: string }[]; _meta?: Record<string, Json> }> {
  const res = await mcp(handler, "tools/call", { name, arguments: args, ...(o.payment ? { _meta: { "x402/payment": o.payment } } : {}) }, o);
  if (res.status !== 200 || !res.body?.result) throw new Error(`tools/call failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.result;
}

let nonce = 0;

/**
 * Підписаний (на заглушці) платіж за першою вимогою з 402: EIP-3009 для eip155:…, base64
 * "transaction" для solana:… (п.8, 15.09: лише Solana лишилась у config.networks, але тест-заглушка
 * фасилітатора (intro-fixtures.ts stubNetwork) не звіряє форму payload, тож рядок-заглушка годиться).
 * Ім'я лишилось evmPayment: так звуться виклики в п'яти тестових файлах, форма підлаштовується сама.
 */
export function evmPayment(required: PaymentRequired, paymentIdentifier?: string): PaymentPayload {
  nonce++;
  const accepted = required.accepts[0] as PaymentRequirements;
  const svm = accepted.network.startsWith("solana:");
  return {
    x402Version: 2,
    resource: required.resource,
    accepted,
    ...(paymentIdentifier ? { extensions: { "payment-identifier": { info: { required: false, id: paymentIdentifier } } } } : {}),
    payload: svm
      ? { transaction: `AQAB-test-tx-${nonce}` }
      : {
          signature: `0x${nonce.toString(16).padStart(130, "0")}`,
          authorization: {
            from: PAYER,
            to: accepted.payTo,
            value: accepted.amount,
            validAfter: "0",
            validBefore: "9999999999",
            nonce: `0x${(nonce + 1_000_000).toString(16).padStart(64, "0")}`,
          },
        },
  };
}

export function paymentHeader(required: PaymentRequired, paymentIdentifier?: string): string {
  return encodePaymentSignatureHeader(evmPayment(required, paymentIdentifier));
}

export function requiredFrom(res: ApiResponse): PaymentRequired {
  return decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!);
}

export function settlementFrom(res: ApiResponse): SettleResponse {
  return decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!);
}

// ---------------------------------------------------------------------------
// Перевірка відповідей схемами openapi.yaml

const openapi = parse(readFileSync(new URL("../../../docs/api/openapi.yaml", import.meta.url), "utf8")) as {
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { schemas: Record<string, unknown>; responses: Record<string, { content?: Record<string, { schema: object }> }> };
};
const DEFS = JSON.parse(JSON.stringify(openapi.components.schemas).replaceAll("#/components/schemas/", "#/$defs/"));

function toDefs(schema: object): object {
  return JSON.parse(JSON.stringify(schema).replaceAll("#/components/schemas/", "#/$defs/"));
}

/** Схема тіла відповіді операції для цього статусу (помилки без опису в операції: Error). */
export function responseSchema(method: string, path: string, status: number): object {
  const op = openapi.paths[path]?.[method.toLowerCase()];
  if (!op) throw new Error(`no operation ${method} ${path} in openapi.yaml`);
  const res = op.responses[String(status)];
  const resolved = res?.$ref ? openapi.components.responses[res.$ref.split("/").at(-1)!] : res;
  const schema = resolved?.content?.["application/json"]?.schema;
  if (schema) return schema;
  if (status === 402) return { $ref: "#/components/schemas/PaymentRequired" };
  return { $ref: "#/components/schemas/Error" };
}

/** Порожній список, якщо тіло відповідає схемі операції з openapi.yaml; інакше помилки. */
export function schemaErrors(method: string, path: string, res: ApiResponse): string[] {
  if (res.status === 204) return res.body === null ? [] : ["204 with a body"];
  const validator = new Validator({ $defs: DEFS, ...toDefs(responseSchema(method, path, res.status)) } as never, "2020-12", false);
  const out = validator.validate(res.body);
  return out.valid ? [] : out.errors.map((e) => `${e.instanceLocation} ${e.error}`);
}
