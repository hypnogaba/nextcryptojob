import type { Outcome } from "@/lib/crm/execute";
import { quotaMeta } from "@/lib/crm/quotas";
import type { ActionError } from "@/lib/crm/types";
import { mcpPaymentRequired, paymentResponseMeta } from "./server";

/**
 * Обгортка x402 для MCP (docs/api/mcp-tools.md, розділ 2; транспорт MCP x402 v2):
 * - платіж приходить у `params._meta["x402/payment"]` як об'єкт PaymentPayload (не base64);
 * - вимога оплати це результат інструмента `{ isError: true, structuredContent: PaymentRequired }`;
 * - оплачений результат несе `_meta["x402/payment-response"]` = SettlementResponse;
 * - квота дії замість заголовків RateLimit-* лежить у `_meta["ncj/quota"]`.
 * Читаємо `ctx.mcpReq._meta` (MCP SDK v2), тому готовий @x402/mcp (SDK v1) не підходить.
 * https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/mcp.md
 */

export const PAYMENT_META = "x402/payment";

export interface ToolResult {
  [key: string]: unknown;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: { type: "text"; text: string }[];
  _meta?: Record<string, unknown>;
}

/** `_meta["x402/payment"]` запиту tools/call або undefined. */
export function readPaymentMeta(meta: Record<string, unknown> | undefined): unknown {
  const value = meta?.[PAYMENT_META];
  return value === null ? undefined : value;
}

/** RateLimit-* з помилки квоти як `_meta["ncj/quota"]`. */
function quotaFromHeaders(headers: Record<string, string> | undefined): Record<string, unknown> | null {
  const limit = headers?.["RateLimit-Limit"];
  if (!limit) return null;
  return {
    "ncj/quota": {
      limit: Number(limit),
      remaining: Number(headers["RateLimit-Remaining"] ?? 0),
      reset_seconds: Number(headers["RateLimit-Reset"] ?? 0),
    },
  };
}

/** Помилка дії як результат інструмента: той самий `{ error: {…} }`, що тіло помилки REST. */
export function mcpError(error: ActionError, requestId: string): ToolResult {
  const body = error.body(requestId);
  const meta = quotaFromHeaders(error.headers);
  return {
    isError: true,
    structuredContent: body as unknown as Record<string, unknown>,
    content: [{ type: "text", text: JSON.stringify(body) }],
    ...(meta ? { _meta: meta } : {}),
  };
}

/** Результат дії як результат інструмента. structuredContent = тіло успішної відповіді REST. */
export function mcpResult(outcome: Outcome, requestId: string): ToolResult {
  switch (outcome.kind) {
    case "ok": {
      const { result, settlement } = outcome;
      const output = (result.output ?? {}) as Record<string, unknown>;
      const meta = {
        ...(result.quota ? quotaMeta(result.quota) : {}),
        ...(settlement ? paymentResponseMeta(settlement) : {}),
      };
      return {
        structuredContent: output,
        content: [{ type: "text", text: JSON.stringify(output) }],
        ...(Object.keys(meta).length ? { _meta: meta } : {}),
      };
    }
    case "payment_required": {
      const result: ToolResult = mcpPaymentRequired(outcome.body, outcome.settlement ?? undefined);
      if (outcome.quota) result._meta = { ...(result._meta ?? {}), ...quotaMeta(outcome.quota) };
      return result;
    }
    case "error":
      return mcpError(outcome.error, requestId);
  }
}
