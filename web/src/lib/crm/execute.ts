import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentRequired as PaymentRequiredBody, SettleResponse } from "@x402/core/types";
import { findUsdcMonth } from "@/lib/billing/usdc";
import { readX402Config, type PaidAction } from "@/lib/x402/config";
import { createPaymentGate, type GateError, type StoredPayment } from "@/lib/x402/server";
import {
  commit,
  prepareAction,
  release,
  reserve,
  run,
  runPrepared,
  PaymentRequired,
  type ActionResult,
  type HandlerResult,
  type PreparedAction,
  type Reservation,
} from "./actions";
import type { ActionContext } from "./context";
import { findIntroByPayment } from "./intros";
import { replaySearch } from "./search";
import { ActionError, type SearchRequest } from "./types";

/**
 * Виконання дії реєстру для REST і MCP разом зі шлюзом x402 (специфікація 7.4).
 * Канал лише перетворює результат на відповідь: REST у lib/x402/http.ts, MCP у
 * lib/x402/mcp.ts. Тут рішення, спільні для обох:
 *
 * 1. prepareAction: вхід, право, стан компанії, доступ, 501. Нічого не пише.
 * 2. Дія не платна для цього актора → reserve → run → commit (як інтерфейс).
 *    Платіж у запиті тоді не чіпаємо: компанія з підпискою не платить x402.
 * 3. Платна, платежу немає → спершу перевірки дії (precheck у reserve: невидимий
 *    кандидат, кулдаун), лише потім 402. Відмова важливіша за вимогу оплати.
 * 4. x402 не налаштовано (немає CDP_API_KEY_* чи адрес отримувача) → помилка
 *    not_configured з назвою того, чого бракує; фасилітатора не питаємо, нічого не списуємо.
 * 5. Платіж є → шлюз: verify з бронею → reserve (квоти, бронь пари) → settle до
 *    ефекту (знайомство, місяць USDC) або до відповіді (пошук) → commit.
 * 6. Ідемпотентний повтор (той самий платіж, payment-identifier і request_hash) →
 *    збережений результат цього платежу; дія вдруге не виконується, облік не пишеться.
 */

export interface ExecuteOptions {
  /** REST: значення PAYMENT-SIGNATURE; MCP: об'єкт `_meta["x402/payment"]`; undefined, якщо платежу немає. */
  payment?: unknown;
  /** Адреса ресурсу для 402 і request_hash: REST без query, MCP `mcp://tool/<name>`. */
  resourceUrl: string;
  /** Для тестів: свій фасилітатор. Інакше клієнт за налаштуваннями. */
  facilitator?: FacilitatorClient;
}

export type Outcome =
  | {
      kind: "ok";
      result: ActionResult;
      /** Розрахунок цього виклику (або збережений при повторі); null, якщо виклик не платний. */
      settlement: SettleResponse | null;
      /** Відповідь на ідемпотентний повтор: нічого не виконано вдруге. */
      replay: boolean;
    }
  | {
      kind: "payment_required";
      body: PaymentRequiredBody;
      /** PAYMENT-REQUIRED, Cache-Control, PAYMENT-RESPONSE (після невдалого settle). */
      headers: Record<string, string>;
      settlement: SettleResponse | null;
    }
  | { kind: "error"; error: ActionError };

/** Опис ресурсу у відповіді 402 (resource.description). */
export const RESOURCE_DESCRIPTIONS: Record<PaidAction, string> = {
  search_candidates: "NextCryptoJob candidate search, one page of up to 20 results",
  request_intro: "NextCryptoJob intro request to one candidate",
  buy_usdc_month: "NextCryptoJob subscription access for 30 days",
};

/** Помилка шлюзу (payment_reused, фасилітатор недоступний, оплачено без результату) як помилка дії. */
function fromGate(error: GateError): ActionError {
  return new ActionError(error.code, error.status, error.message, error.details);
}

export async function executeAction(name: string, rawInput: unknown, ctx: ActionContext, opts: ExecuteOptions): Promise<Outcome> {
  try {
    const prepared = prepareAction(name, rawInput, ctx);
    if (!prepared.payment) {
      return { kind: "ok", result: await runPrepared(prepared), settlement: null, replay: false };
    }
    return await paidPath(prepared, opts);
  } catch (error) {
    if (error instanceof ActionError) return { kind: "error", error };
    throw error;
  }
}

function hasPayment(payment: unknown): boolean {
  return payment !== undefined && payment !== null && payment !== "";
}

async function paidPath(prepared: PreparedAction, opts: ExecuteOptions): Promise<Outcome> {
  const price = prepared.payment!;
  const { ctx } = prepared;

  if (!hasPayment(opts.payment)) {
    // Перевірки дії до вимоги оплати: reserve без платежу кидає PaymentRequired лише після precheck.
    try {
      await reserve(prepared, null);
    } catch (error) {
      if (!(error instanceof PaymentRequired)) throw error;
    }
  }

  const config = readX402Config(ctx.env);
  if (!config.enabled) {
    // Жодного звернення до фасилітатора: без ключів і адрес оплата не може піти, і ми не вдаємо, що може.
    // Гість отримує 401 (специфікація 7.3); компанія з чинним ключем 503, як NotConfigured в openapi.yaml.
    return {
      kind: "error",
      error: new ActionError(
        "not_configured",
        ctx.actor.kind === "x402_guest" ? 401 : 503,
        `Payments are not configured on this server (${config.reason}).`,
        { missing: [...config.missing] },
      ),
    };
  }

  const gate = createPaymentGate({ db: ctx.db, config, facilitator: opts.facilitator });
  let reservation: Reservation | undefined;
  const paid = gate.withPayment<HandlerResult<unknown>, ActionError>(price.action, price.settle, {
    validate: async (p) => {
      try {
        reservation = await reserve(prepared, { id: p.paymentId, payer: p.payer });
      } catch (error) {
        if (error instanceof ActionError) return error;
        throw error;
      }
    },
    effect: () => run(prepared),
  });

  let out;
  try {
    out = await paid({
      payment: opts.payment,
      input: prepared.input,
      resource: { url: opts.resourceUrl, description: RESOURCE_DESCRIPTIONS[price.action] },
      context: {
        channel: ctx.channel === "mcp" ? "mcp" : "rest",
        companyId: ctx.company?.id ?? null,
        apiKeyId: ctx.actor.kind === "agent" ? ctx.actor.keyId : null,
        requestId: ctx.requestId,
      },
    });
  } catch (error) {
    // Пошук (before_response) упав до settle: шлюз уже зняв бронь платежу, знімаємо квоту.
    if (reservation) await release(reservation, error instanceof ActionError ? error.status : 500);
    throw error;
  }

  switch (out.kind) {
    case "ok": {
      try {
        const result = await commit(reservation!, out.value);
        return { kind: "ok", result, settlement: out.settlement, replay: false };
      } catch (error) {
        // Гроші пішли, а облік чи журнал не записались: без відповіді з даними, з id платежу для звірки.
        console.error("x402: paid action could not be committed", {
          paymentId: out.payment.paymentId,
          action: price.action,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          kind: "error",
          error: new ActionError("internal", 500, "Payment was received but the result could not be saved. Contact support with the payment id.", {
            payment_id: out.payment.paymentId,
            transaction: out.settlement.transaction,
          }),
        };
      }
    }
    case "replay": {
      const stored = await storedResult(prepared, out.payment);
      if (!stored) {
        return {
          kind: "error",
          error: new ActionError("internal", 500, "This payment was received, but its result is not available. Contact support with the payment id.", {
            payment_id: out.payment.id,
          }),
        };
      }
      return { kind: "ok", result: stored, settlement: out.settlement, replay: true };
    }
    case "payment_required":
      if (reservation) await release(reservation, 402);
      return { kind: "payment_required", body: out.response.body, headers: out.response.headers, settlement: out.settlement ?? null };
    case "rejected":
      return { kind: "error", error: out.error };
    case "error":
      if (reservation) await release(reservation, out.error.status);
      return { kind: "error", error: fromGate(out.error) };
  }
}

/**
 * Збережений результат оплаченого запиту для ідемпотентного повтору: знайомство й
 * місяць USDC за id платежу, сторінка пошуку з рядка журналу. Статус той самий,
 * що першого разу. null, якщо результату немає (дія впала після settle).
 */
async function storedResult(prepared: PreparedAction, payment: StoredPayment): Promise<ActionResult | null> {
  const { def, ctx } = prepared;
  const headers: Record<string, string> = {};
  switch (payment.action) {
    case "request_intro": {
      if (!ctx.company) return null;
      const intro = await findIntroByPayment(ctx.db, ctx.company.id, payment.id);
      return intro ? { output: intro, status: def.rest.status, quota: null, headers } : null;
    }
    case "buy_usdc_month": {
      if (!ctx.company) return null;
      const month = await findUsdcMonth(ctx.db, ctx.company.id, payment.id);
      return month ? { output: month, status: def.rest.status, quota: null, headers } : null;
    }
    case "search_candidates": {
      const page = await replaySearch(ctx, prepared.input as SearchRequest, payment.id);
      return page ? { output: page, status: def.rest.status, quota: null, headers } : null;
    }
  }
}
