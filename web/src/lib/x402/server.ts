import { encodePaymentRequiredHeader, encodePaymentResponseHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import { isPaymentPayloadV2 } from "@x402/core/schemas";
import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import {
  SettleError,
  VerifyError,
  type Network,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type ResourceInfo,
  type SettleResponse,
} from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { PRICES, type PaidAction, type X402Config } from "./config";
import { createFacilitatorClient } from "./facilitator";

/**
 * Тонка обгортка x402 над `x402ResourceServer` для REST і MCP (специфікація CRM, 7.3–7.5).
 *
 * `@x402/mcp` (MCP SDK v1) і `agents/x402` (лише EVM) нам не підходять, тож тут
 * лише ядро протоколу; перетворення на відповідь REST чи MCP роблять http.ts і mcp.ts.
 *
 * Потік одного платного запиту (розділ 7.4):
 * 1. requirementsFor → вимоги для Base і Solana з однаковою ціною.
 * 2. Платежу немає → paymentRequired (402, PAYMENT-REQUIRED у base64).
 * 3. verify: розбір, хеш платежу, рядок x402_payments(status='verified') як бронь
 *    (UNIQUE не дає використати платіж двічі), потім verifyPayment фасилітатора.
 * 4. Перевірки дії робить викликач, до розрахунку.
 * 5. settle: before_effect (знайомство, місяць USDC) або before_response (пошук).
 * 6–7. Невдалий settle → 402 з PAYMENT-RESPONSE success:false і status='failed';
 *    вдалий → status='settled', tx, settled_at.
 * `withPayment` зводить кроки 2–7 в одне ціле.
 *
 * Що буває з рядком x402_payments:
 * - фасилітатор визнав платіж хибним → 'failed' з причиною (той самий платіж більше не приймаємо);
 * - фасилітатор недоступний або дія відмовила до розрахунку → бронь видаляємо: гроші
 *   не рухались, клієнт може повторити той самий підписаний платіж;
 * - після settle рядок лишається назавжди ('settled' або 'failed').
 */

/** Шлях розрахунку дії (розділ 7.4). */
export type SettleTiming = "before_effect" | "before_response";
export type PaymentChannel = "rest" | "mcp";

/** Помилка з кодом із openapi.yaml#/components/schemas/Error. */
export type GateErrorCode = "not_configured" | "payment_reused" | "internal";

export interface GateError {
  status: number;
  code: GateErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export class X402Error extends Error {
  constructor(readonly gate: GateError) {
    super(gate.message);
    this.name = "X402Error";
  }
}

/** Вимоги оплати для однієї дії: те, що йде в `accepts` відповіді 402. */
export interface PaymentRequirementsSet {
  action: PaidAction;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions: Record<string, unknown>;
}

/** Відповідь 402 для REST. Тіло дублює заголовок PAYMENT-REQUIRED (openapi PaymentRequired). */
export interface PaymentRequiredResponse {
  status: 402;
  headers: Record<string, string>;
  body: PaymentRequired;
}

/** Хто платить і яким каналом: іде в рядок x402_payments. */
export interface PaymentContext {
  channel: PaymentChannel;
  companyId?: string | null;
  apiKeyId?: string | null;
  requestId?: string | null;
}

/** Платіж пройшов verify і заброньований у x402_payments. */
export interface VerifiedPayment {
  paymentId: string;
  action: PaidAction;
  payload: PaymentPayload;
  requirements: PaymentRequirements;
  set: PaymentRequirementsSet;
  payer: string | null;
  paymentIdentifier: string | null;
  payloadHash: string;
}

/** Рядок x402_payments, повернутий при ідемпотентному повторі. */
export interface StoredPayment {
  id: string;
  status: "verified" | "settled" | "failed";
  action: PaidAction;
  network: Network;
  tx: string | null;
  payer: string | null;
  paymentIdentifier: string | null;
  errorReason: string | null;
  settledAt: string | null;
}

export type VerifyResult =
  | { ok: true; payment: VerifiedPayment }
  /** Той самий payment-identifier і той самий платіж: віддати збережений результат. */
  | { ok: false; kind: "replay"; payment: StoredPayment }
  | { ok: false; kind: "payment_required"; response: PaymentRequiredResponse }
  | { ok: false; kind: "error"; error: GateError };

export type SettleResult =
  | { ok: true; paymentId: string; settlement: SettleResponse }
  | { ok: false; paymentId: string; settlement: SettleResponse; response: PaymentRequiredResponse };

export type PaidOutcome<T, E> =
  | { kind: "ok"; value: T; payment: VerifiedPayment; settlement: SettleResponse }
  | { kind: "replay"; payment: StoredPayment; settlement: SettleResponse }
  | { kind: "payment_required"; response: PaymentRequiredResponse; settlement?: SettleResponse }
  /** Перевірка дії відмовила до розрахунку: нічого не списано, бронь знято. */
  | { kind: "rejected"; error: E }
  | { kind: "error"; error: GateError };

export interface PaidRequest {
  /** REST: значення заголовка PAYMENT-SIGNATURE; MCP: об'єкт `_meta["x402/payment"]`. */
  payment: unknown;
  resource: { url: string; description: string };
  context: PaymentContext;
}

export interface PaidHandlers<T, E> {
  /** Крок 4: усі перевірки дії (видимість, кулдауни, квоти, валідація). Повернути помилку, щоб відмовити. */
  validate?: (payment: VerifiedPayment) => Promise<E | null | undefined | void>;
  /**
   * Сама дія. before_effect: запускається лише після вдалого settle.
   * before_response: запускається до settle, тож не повинна нічого записувати;
   * облік (usage_events, audit_log) пише викликач після outcome "ok".
   */
  effect: (payment: VerifiedPayment) => Promise<T>;
}

export interface PaymentGate {
  readonly enabled: boolean;
  readonly config: X402Config;
  requirementsFor(action: PaidAction, resource: { url: string; description: string }): Promise<PaymentRequirementsSet>;
  paymentRequired(
    set: PaymentRequirementsSet,
    options?: { error?: string; settlement?: SettleResponse; payload?: PaymentPayload },
  ): Promise<PaymentRequiredResponse>;
  verify(payment: unknown, set: PaymentRequirementsSet, context: PaymentContext): Promise<VerifyResult>;
  settle(payment: VerifiedPayment): Promise<SettleResult>;
  withPayment<T, E = never>(
    action: PaidAction,
    timing: SettleTiming,
    handlers: PaidHandlers<T, E>,
  ): (request: PaidRequest) => Promise<PaidOutcome<T, E>>;
}

export interface PaymentGateOptions {
  db: D1Database;
  config: X402Config;
  /** Для тестів або свого клієнта; інакше клієнт за налаштуваннями з кешем на ізолят. */
  facilitator?: FacilitatorClient;
}

const SERVICE_NAME = "NextCryptoJob";
/** Вікно на підпис і розрахунок, як у прикладі openapi.yaml. */
const MAX_TIMEOUT_SECONDS = 60;
const RESOURCE_SERVER_TTL_MS = 60 * 60 * 1000;
const REST_MISSING_PAYMENT = "PAYMENT-SIGNATURE header is required";
const MCP_MISSING_PAYMENT = "Payment required";

/** Розширення ідемпотентності, яке оголошуємо в кожній відповіді 402. */
const PAYMENT_IDENTIFIER = "payment-identifier";
const PAYMENT_IDENTIFIER_DECLARATION = {
  info: { required: false },
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      required: { type: "boolean" },
      id: { type: "string", minLength: 16, maxLength: 128 },
    },
    required: ["required"],
  },
};
const PAYMENT_ID_FORMAT = /^[A-Za-z0-9_-]{16,128}$/;

// ---------------------------------------------------------------------------
// Хеш платежу

/** JSON з відсортованими ключами на всіх рівнях, без пробілів (для хешу). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * payload_hash: SHA-256 канонічного JSON підписаної частини платежу
 * (`x402Version`, `accepted.scheme`, `accepted.network`, `payload`).
 *
 * `resource` і `extensions` клієнт може змінити, не підписуючи нічого заново.
 * Якби вони входили в хеш, той самий підписаний платіж з іншим payment-identifier
 * дав би новий хеш і пройшов би UNIQUE.
 */
export async function paymentPayloadHash(payload: PaymentPayload): Promise<string> {
  return sha256Hex(
    canonicalJson({
      x402Version: payload.x402Version,
      scheme: payload.accepted.scheme,
      network: payload.accepted.network,
      payload: payload.payload,
    }),
  );
}

// ---------------------------------------------------------------------------
// Дрібні помічники

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** 'pay_' + 20 символів base62 з crypto.getRandomValues (специфікація 3.5). */
export function newPaymentId(): string {
  let out = "pay_";
  while (out.length < 24) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      // 248 = 4·62: відкидаємо хвіст, щоб усі символи були рівноймовірні.
      if (byte < 248 && out.length < 24) out += BASE62[byte % 62];
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Текст помилки разом з причиною (initialize ховає відповідь фасилітатора в cause). */
function errorText(error: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = error, depth = 0; e !== undefined && e !== null && depth < 3; depth++) {
    parts.push(e instanceof Error ? e.message : String(e));
    e = e instanceof Error ? e.cause : undefined;
  }
  return parts.join(": ").slice(0, 500);
}

/** Розбирає платіж з заголовка (base64) або з `_meta` MCP (об'єкт). Лише x402 v2. */
export function decodePayment(input: unknown): PaymentPayload | null {
  let value = input;
  if (typeof input === "string") {
    try {
      value = decodePaymentSignatureHeader(input.trim());
    } catch {
      return null;
    }
  }
  if (!isRecord(value) || !isPaymentPayloadV2(value) || !isRecord(value.payload)) return null;
  return value as PaymentPayload;
}

/** id з розширення payment-identifier: null, якщо клієнт його не дав; undefined, якщо формат хибний. */
function readPaymentIdentifier(payload: PaymentPayload): string | null | undefined {
  const ext = payload.extensions?.[PAYMENT_IDENTIFIER];
  if (ext === undefined) return null;
  const id = isRecord(ext) && isRecord(ext.info) ? ext.info.id : undefined;
  if (id === undefined) return null;
  return typeof id === "string" && PAYMENT_ID_FORMAT.test(id) ? id : undefined;
}

/** Заголовок PAYMENT-RESPONSE для REST (base64 SettlementResponse). */
export function paymentResponseHeader(settlement: SettleResponse): { "PAYMENT-RESPONSE": string } {
  return { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settlement) };
}

/** `_meta["x402/payment-response"]` для результату інструмента MCP. */
export function paymentResponseMeta(settlement: SettleResponse): { "x402/payment-response": SettleResponse } {
  const { extensionResponses: _internal, ...buyerFacing } = settlement;
  return { "x402/payment-response": buyerFacing };
}

/** Результат інструмента MCP замість 402 (docs/api/mcp-tools.md, розділ 2). */
export function mcpPaymentRequired(body: PaymentRequired, settlement?: SettleResponse) {
  return {
    isError: true as const,
    structuredContent: body as unknown as Record<string, unknown>,
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
    ...(settlement ? { _meta: paymentResponseMeta(settlement) } : {}),
  };
}

/** Тіло помилки REST: `{ error: { code, message, request_id, details? } }`. */
export function gateErrorBody(error: GateError, requestId: string) {
  return {
    error: {
      code: error.code,
      message: error.message,
      request_id: requestId,
      ...(error.details ? { details: error.details } : {}),
    },
  };
}

function storedSettlement(payment: StoredPayment): SettleResponse {
  return {
    success: payment.status === "settled",
    transaction: payment.tx ?? "",
    network: payment.network,
    ...(payment.payer ? { payer: payment.payer } : {}),
    ...(payment.errorReason ? { errorReason: payment.errorReason } : {}),
  };
}

// ---------------------------------------------------------------------------
// x402ResourceServer з кешем на ізолят Worker

type EnabledConfig = Extract<X402Config, { enabled: true }>;

const serverCache = new Map<string, { at: number; server: Promise<x402ResourceServer> }>();

/** Для тестів і після зміни налаштувань: наступний запит знову спитає /supported. */
export function clearResourceServerCache(): void {
  serverCache.clear();
}

function cacheKey(config: EnabledConfig): string {
  return JSON.stringify([
    config.mode,
    config.facilitator.kind,
    config.facilitator.url,
    config.facilitator.auth?.apiKeyId ?? null,
    config.networks.map((n) => n.network),
  ]);
}

async function initResourceServer(config: EnabledConfig, facilitator: FacilitatorClient): Promise<x402ResourceServer> {
  const rs = new x402ResourceServer(facilitator);
  for (const n of config.networks) {
    rs.register(n.network, n.family === "evm" ? new ExactEvmScheme() : new ExactSvmScheme());
  }
  // GET /supported: мережі фасилітатора і feePayer для Solana. Раз на годину на ізолят, не на кожен запит.
  await rs.initialize();
  return rs;
}

// ---------------------------------------------------------------------------

export function createPaymentGate({ db, config, facilitator }: PaymentGateOptions): PaymentGate {
  // 401, як велить специфікація 7.3 («гість отримує 401 not_configured»); текст називає, чого бракує.
  const notConfigured: GateError = {
    status: 401,
    code: "not_configured",
    message: config.enabled ? "" : config.reason,
  };
  let ownServer: Promise<x402ResourceServer> | null = null;

  async function resourceServer(): Promise<x402ResourceServer> {
    if (!config.enabled) throw new X402Error(notConfigured);
    let pending: Promise<x402ResourceServer>;
    if (facilitator) {
      ownServer ??= initResourceServer(config, facilitator);
      pending = ownServer;
    } else {
      const key = cacheKey(config);
      const hit = serverCache.get(key);
      if (hit && Date.now() - hit.at < RESOURCE_SERVER_TTL_MS) {
        pending = hit.server;
      } else {
        pending = initResourceServer(config, createFacilitatorClient(config.facilitator));
        serverCache.set(key, { at: Date.now(), server: pending });
      }
    }
    try {
      return await pending;
    } catch (error) {
      // Невдачу не кешуємо: наступний запит спробує ще раз.
      if (facilitator) ownServer = null;
      else serverCache.delete(cacheKey(config));
      throw new X402Error({
        status: 503,
        code: "internal",
        message: "Payment facilitator is unavailable. Try again in a minute.",
        details: { reason: errorText(error) },
      });
    }
  }

  async function requirementsFor(
    action: PaidAction,
    resource: { url: string; description: string },
  ): Promise<PaymentRequirementsSet> {
    const rs = await resourceServer();
    if (!config.enabled) throw new X402Error(notConfigured);
    const price = PRICES[action];
    const accepts: PaymentRequirements[] = [];
    for (const n of config.networks) {
      try {
        const built = await rs.buildPaymentRequirements({
          scheme: "exact",
          network: n.network,
          payTo: n.payTo,
          // Сума й актив явно з налаштувань (7.3), без типових значень бібліотеки.
          price: { amount: price.amount, asset: n.asset, extra: { ...n.extra } },
          maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
        });
        accepts.push(...built);
      } catch (error) {
        throw new X402Error({
          status: 503,
          code: "internal",
          message: `Payment facilitator does not accept ${n.network} right now.`,
          details: { reason: errorText(error) },
        });
      }
    }
    return {
      action,
      resource: { url: resource.url, description: resource.description, mimeType: "application/json", serviceName: SERVICE_NAME },
      accepts,
      extensions: { [PAYMENT_IDENTIFIER]: PAYMENT_IDENTIFIER_DECLARATION },
    };
  }

  async function paymentRequired(
    set: PaymentRequirementsSet,
    options: { error?: string; settlement?: SettleResponse; payload?: PaymentPayload } = {},
  ): Promise<PaymentRequiredResponse> {
    const rs = await resourceServer();
    const body = await rs.createPaymentRequiredResponse(
      set.accepts,
      set.resource,
      options.error ?? REST_MISSING_PAYMENT,
      set.extensions,
      undefined,
      options.payload,
    );
    return {
      status: 402,
      headers: {
        "PAYMENT-REQUIRED": encodePaymentRequiredHeader(body),
        "Cache-Control": "no-store",
        ...(options.settlement ? paymentResponseHeader(options.settlement) : {}),
      },
      body,
    };
  }

  async function required(set: PaymentRequirementsSet, error: string, payload?: PaymentPayload) {
    return { ok: false as const, kind: "payment_required" as const, response: await paymentRequired(set, { error, payload }) };
  }

  async function release(paymentId: string): Promise<void> {
    await db.prepare("DELETE FROM x402_payments WHERE id = ?1 AND status = 'verified'").bind(paymentId).run();
  }

  async function markFailed(paymentId: string, reason: string, payer: string | null = null): Promise<void> {
    await db
      .prepare(
        `UPDATE x402_payments SET status = 'failed', error_reason = ?2, payer = COALESCE(?3, payer)
         WHERE id = ?1 AND status = 'verified'`,
      )
      .bind(paymentId, reason.slice(0, 500), payer)
      .run();
  }

  async function resolveConflict(
    set: PaymentRequirementsSet,
    context: PaymentContext,
    payloadHash: string,
    identifier: string | null,
  ): Promise<VerifyResult> {
    const reused: VerifyResult = {
      ok: false,
      kind: "error",
      error: {
        status: 409,
        code: "payment_reused",
        message: "This payment was already used. Sign a new payment for this request.",
      },
    };
    if (identifier === null) return reused;
    const row = await db
      .prepare(
        `SELECT id, payload_hash, company_id, action, network, status, tx, payer, payment_identifier, error_reason, settled_at
         FROM x402_payments WHERE payment_identifier = ?1`,
      )
      .bind(identifier)
      .first<Record<string, string | null>>();
    // Повтор лише для того самого платежу, тієї самої дії й того самого платника (компанії чи гостя).
    if (
      !row ||
      row.payload_hash !== payloadHash ||
      row.action !== set.action ||
      (row.company_id ?? null) !== (context.companyId ?? null)
    ) {
      return reused;
    }
    return {
      ok: false,
      kind: "replay",
      payment: {
        id: row.id!,
        status: row.status as StoredPayment["status"],
        action: row.action as PaidAction,
        network: row.network as Network,
        tx: row.tx,
        payer: row.payer,
        paymentIdentifier: row.payment_identifier,
        errorReason: row.error_reason,
        settledAt: row.settled_at,
      },
    };
  }

  async function verify(input: unknown, set: PaymentRequirementsSet, context: PaymentContext): Promise<VerifyResult> {
    if (!config.enabled) return { ok: false, kind: "error", error: notConfigured };
    let rs: x402ResourceServer;
    try {
      rs = await resourceServer();
    } catch (error) {
      if (error instanceof X402Error) return { ok: false, kind: "error", error: error.gate };
      throw error;
    }

    const payload = decodePayment(input);
    if (!payload) return required(set, "invalid_payment: not a valid x402 v2 payment payload");

    const matched = rs.findMatchingRequirements(set.accepts, payload);
    if (!matched) return required(set, "No matching payment requirements", payload);

    const echo = rs.validateExtensions(
      { x402Version: 2, resource: set.resource, accepts: set.accepts, extensions: set.extensions },
      payload,
    );
    if (!echo.valid) return required(set, echo.invalidReason, payload);

    const identifier = readPaymentIdentifier(payload);
    if (identifier === undefined) {
      return required(set, "invalid_payment_identifier: id must be 16 to 128 characters of A-Z, a-z, 0-9, _ or -", payload);
    }

    const payloadHash = await paymentPayloadHash(payload);
    const paymentId = newPaymentId();
    const price = PRICES[set.action];
    const inserted = await db
      .prepare(
        `INSERT INTO x402_payments (id, payload_hash, payment_identifier, company_id, api_key_id, network, asset,
           pay_to, amount_atomic, amount_usd_cents, action, channel, status, facilitator, request_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'verified', ?13, ?14)
         ON CONFLICT DO NOTHING`,
      )
      .bind(
        paymentId,
        payloadHash,
        identifier,
        context.companyId ?? null,
        context.apiKeyId ?? null,
        matched.network,
        matched.asset,
        matched.payTo,
        matched.amount,
        price.usdCents,
        set.action,
        context.channel,
        config.facilitator.kind,
        context.requestId ?? null,
      )
      .run();
    if (inserted.meta.changes === 0) return resolveConflict(set, context, payloadHash, identifier);

    let result: { isValid: boolean; invalidReason?: string; payer?: string };
    try {
      result = await rs.verifyPayment(payload, matched);
    } catch (error) {
      if (error instanceof VerifyError) {
        result = { isValid: false, invalidReason: error.invalidReason ?? "invalid_payment", payer: error.payer };
      } else {
        // Фасилітатор не відповів: гроші не рухались, бронь знімаємо, той самий платіж можна повторити.
        await release(paymentId);
        return {
          ok: false,
          kind: "error",
          error: {
            status: 503,
            code: "internal",
            message: "Payment facilitator is unavailable. Retry the same payment in a minute.",
            details: { reason: errorText(error) },
          },
        };
      }
    }

    if (!result.isValid) {
      const reason = result.invalidReason ?? "invalid_payment";
      await markFailed(paymentId, reason, result.payer ?? null);
      return required(set, reason, payload);
    }

    const payer = result.payer ?? null;
    if (payer) await db.prepare("UPDATE x402_payments SET payer = ?2 WHERE id = ?1").bind(paymentId, payer).run();
    return {
      ok: true,
      payment: { paymentId, action: set.action, payload, requirements: matched, set, payer, paymentIdentifier: identifier, payloadHash },
    };
  }

  async function settle(payment: VerifiedPayment): Promise<SettleResult> {
    const rs = await resourceServer();
    const network = payment.requirements.network;
    let settlement: SettleResponse;
    try {
      settlement = await rs.settlePayment(payment.payload, payment.requirements);
    } catch (error) {
      settlement =
        error instanceof SettleError
          ? {
              success: false,
              errorReason: error.errorReason ?? "settle_failed",
              ...(error.errorMessage ? { errorMessage: error.errorMessage } : {}),
              transaction: error.transaction ?? "",
              network: error.network ?? network,
              ...(error.payer ? { payer: error.payer } : {}),
            }
          : // Таймаут чи збій мережі: результат у ланцюжку невідомий, адмін звірить за tx платника.
            { success: false, errorReason: "settle_unconfirmed", errorMessage: errorText(error), transaction: "", network };
    }

    if (settlement.success && !settlement.transaction) {
      settlement = { ...settlement, success: false, errorReason: "settle_missing_transaction" };
    }

    if (settlement.success) {
      // OR IGNORE: той самий tx уже записаний за іншим платежем (UNIQUE network, tx) → це не нова оплата.
      const updated = await db
        .prepare(
          `UPDATE OR IGNORE x402_payments
           SET status = 'settled', tx = ?2, payer = COALESCE(?3, payer), settled_at = datetime('now'), error_reason = NULL
           WHERE id = ?1 AND status = 'verified'`,
        )
        .bind(payment.paymentId, settlement.transaction, settlement.payer ?? payment.payer)
        .run();
      if (updated.meta.changes === 1) return { ok: true, paymentId: payment.paymentId, settlement };
      settlement = { ...settlement, success: false, errorReason: "duplicate_transaction" };
    }

    await markFailed(
      payment.paymentId,
      [settlement.errorReason ?? "settle_failed", settlement.errorMessage].filter(Boolean).join(": "),
      settlement.payer ?? null,
    );
    const response = await paymentRequired(payment.set, {
      error: settlement.errorReason ?? "settle_failed",
      settlement,
      payload: payment.payload,
    });
    return { ok: false, paymentId: payment.paymentId, settlement, response };
  }

  function withPayment<T, E = never>(action: PaidAction, timing: SettleTiming, handlers: PaidHandlers<T, E>) {
    return async (request: PaidRequest): Promise<PaidOutcome<T, E>> => {
      if (!config.enabled) return { kind: "error", error: notConfigured };

      let set: PaymentRequirementsSet;
      try {
        set = await requirementsFor(action, request.resource);
      } catch (error) {
        if (error instanceof X402Error) return { kind: "error", error: error.gate };
        throw error;
      }

      // Крок 2: платежу немає.
      const missing = request.payment === undefined || request.payment === null || request.payment === "";
      if (missing) {
        const message = request.context.channel === "mcp" ? MCP_MISSING_PAYMENT : REST_MISSING_PAYMENT;
        return { kind: "payment_required", response: await paymentRequired(set, { error: message }) };
      }

      // Крок 3: verify з бронею.
      const verified = await verify(request.payment, set, request.context);
      if (!verified.ok) {
        if (verified.kind === "payment_required") return { kind: "payment_required", response: verified.response };
        if (verified.kind === "error") return { kind: "error", error: verified.error };
        const stored = verified.payment;
        if (stored.status === "settled") return { kind: "replay", payment: stored, settlement: storedSettlement(stored) };
        if (stored.status === "failed") {
          // Той самий платіж уже провалився: повторюємо ту саму відмову, без нової спроби.
          return { kind: "payment_required", response: await paymentRequired(set, { error: stored.errorReason ?? "payment_failed" }) };
        }
        return {
          kind: "error",
          error: {
            status: 409,
            code: "payment_reused",
            message: "This payment is still being processed. Retry in a few seconds.",
          },
        };
      }
      const payment = verified.payment;

      // Крок 4: перевірки дії до розрахунку.
      if (handlers.validate) {
        let rejection: E | null | undefined | void;
        try {
          rejection = await handlers.validate(payment);
        } catch (error) {
          await release(payment.paymentId);
          throw error;
        }
        if (rejection !== undefined && rejection !== null) {
          await release(payment.paymentId);
          return { kind: "rejected", error: rejection };
        }
      }

      if (timing === "before_effect") {
        // 5a: спершу гроші, потім дія (сповіщення людини не відкотиш).
        const settled = await settle(payment);
        if (!settled.ok) return { kind: "payment_required", response: settled.response, settlement: settled.settlement };
        try {
          const value = await handlers.effect(payment);
          return { kind: "ok", value, payment, settlement: settled.settlement };
        } catch (error) {
          // Оплачено, а дія впала: платіж лишається settled, адмін бачить його в "Paid without result".
          console.error("x402: paid action failed", { paymentId: payment.paymentId, action, error: errorText(error) });
          return {
            kind: "error",
            error: {
              status: 500,
              code: "internal",
              message: "Payment was received but the action failed. Contact support with the payment id.",
              details: { payment_id: payment.paymentId },
            },
          };
        }
      }

      // 5b: before_response. Спершу результат, потім гроші, і лише тоді віддаємо.
      let value: T;
      try {
        value = await handlers.effect(payment);
      } catch (error) {
        await release(payment.paymentId);
        throw error;
      }
      const settled = await settle(payment);
      if (!settled.ok) return { kind: "payment_required", response: settled.response, settlement: settled.settlement };
      return { kind: "ok", value, payment, settlement: settled.settlement };
    };
  }

  return {
    enabled: config.enabled,
    config,
    requirementsFor,
    paymentRequired,
    verify,
    settle,
    withPayment,
  };
}
