import type { Outcome } from "@/lib/crm/execute";
import { rateLimitHeaders } from "@/lib/crm/quotas";
import type { ActionError } from "@/lib/crm/types";
import { paymentResponseHeader } from "./server";

/**
 * Обгортка x402 для REST (специфікація CRM, 7.1 і 7.4; транспорт HTTP x402 v2):
 * - платіж приходить заголовком PAYMENT-SIGNATURE (base64 PaymentPayload);
 * - 402: заголовок PAYMENT-REQUIRED (base64) і те саме тіло PaymentRequired, Cache-Control: no-store;
 * - оплачена відповідь і невдалий settle несуть PAYMENT-RESPONSE (base64 SettlementResponse);
 * - кожна відповідь має X-Request-Id; дії з квотою ще RateLimit-*; 429 ще Retry-After.
 * https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md
 */

export const PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";

/** Значення PAYMENT-SIGNATURE або undefined, якщо платежу немає. */
export function readPaymentSignature(request: Request): string | undefined {
  const value = request.headers.get(PAYMENT_SIGNATURE)?.trim();
  return value ? value : undefined;
}

function baseHeaders(requestId: string): Record<string, string> {
  return { "X-Request-Id": requestId, "Cache-Control": "no-store" };
}

/** Тіло помилки `{ error: { code, message, request_id, details? } }` з її заголовками. */
export function errorResponse(error: ActionError, requestId: string, extra: Record<string, string> = {}): Response {
  return Response.json(error.body(requestId), {
    status: error.status,
    headers: { ...baseHeaders(requestId), ...(error.headers ?? {}), ...extra },
  });
}

/** Результат дії як відповідь REST. */
export function restResponse(outcome: Outcome, requestId: string): Response {
  switch (outcome.kind) {
    case "ok": {
      const { result, settlement } = outcome;
      const headers = {
        ...baseHeaders(requestId),
        ...result.headers,
        ...(settlement ? paymentResponseHeader(settlement) : {}),
      };
      if (result.status === 204) return new Response(null, { status: 204, headers });
      return Response.json(result.output, { status: result.status, headers });
    }
    case "payment_required":
      return Response.json(outcome.body, {
        status: 402,
        headers: { ...baseHeaders(requestId), ...(outcome.quota ? rateLimitHeaders(outcome.quota) : {}), ...outcome.headers },
      });
    case "error":
      return errorResponse(outcome.error, requestId);
  }
}
