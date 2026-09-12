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
import { newId } from "@/lib/ids";
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
 * 3. verify: розбір, хеші платежу й запиту, рядок x402_payments(status='verified') як бронь
 *    (UNIQUE не дає використати платіж двічі), потім verifyPayment фасилітатора.
 * 4. Перевірки дії робить викликач, до розрахунку.
 * 5. settle: before_effect (знайомство, місяць USDC) або before_response (пошук).
 * 6–7. Невдалий settle → 402 з PAYMENT-RESPONSE success:false;
 *    вдалий → status='settled', tx, settled_at.
 * `withPayment` зводить кроки 2–7 в одне ціле і бере x402ResourceServer один раз на запит.
 *
 * Що буває з рядком x402_payments:
 * - фасилітатор визнав платіж хибним → 'failed' з причиною (той самий платіж більше не приймаємо);
 * - фасилітатор недоступний або дія відмовила до розрахунку → бронь видаляємо: гроші
 *   не рухались, клієнт може повторити той самий підписаний платіж;
 * - settle відмовив → 'failed' (tx зберігаємо, якщо фасилітатор його дав);
 * - settle без відповіді або pending → 'unconfirmed' (гроші могли піти, адмін звіряє);
 * - гроші пішли, а запис 'settled' не вдався навіть з повторами → 500 з payment_id і tx,
 *   рядок лишається 'verified', і findStalePayments покаже його адмінці.
 *
 * Текст помилок фасилітатора й бази клієнт не бачить ніколи: лише в журналі сервера.
 */

/** Шлях розрахунку дії (розділ 7.4). */
export type SettleTiming = "before_effect" | "before_response";
export type PaymentChannel = "rest" | "mcp";
export type PaymentStatus = "verified" | "settled" | "failed" | "unconfirmed";

/** Помилка з кодом із openapi.yaml#/components/schemas/Error. */
export type GateErrorCode = "not_configured" | "payment_reused" | "internal";

export interface GateError {
  status: number;
  code: GateErrorCode;
  /** Загальний текст для клієнта; подробиці лише в журналі сервера. */
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
  requestHash: string;
  /**
   * Той самий x402ResourceServer, що перевіряв платіж: settle і відповідь 402 після нього
   * не питають фасилітатора знову (кеш міг сплинути, /supported міг лягти).
   * Властивість не перелічується, тож у JSON і журнал не потрапляє.
   */
  readonly resourceServer: x402ResourceServer;
}

/** Рядок x402_payments, повернутий при ідемпотентному повторі. */
export interface StoredPayment {
  id: string;
  status: PaymentStatus;
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
  /**
   * Той самий payment-identifier, той самий платіж, та сама дія, той самий запит (request_hash)
   * і та сама компанія. Дію вдруге НЕ виконувати: віддати збережений результат за `payment.id`.
   */
  | { ok: false; kind: "replay"; payment: StoredPayment }
  | { ok: false; kind: "payment_required"; response: PaymentRequiredResponse }
  | { ok: false; kind: "error"; error: GateError };

export type SettleResult =
  | { ok: true; paymentId: string; settlement: SettleResponse }
  /** Розрахунок не пройшов або не підтверджений: 402 з PAYMENT-RESPONSE success:false, без даних. */
  | { ok: false; kind: "settle_failed"; paymentId: string; settlement: SettleResponse; response: PaymentRequiredResponse }
  /** Гроші пішли (є tx), але рядок 'settled' записати не вдалося: 500 з payment_id і transaction. */
  | { ok: false; kind: "record_failed"; paymentId: string; settlement: SettleResponse; error: GateError };

export type PaidOutcome<T, E> =
  | { kind: "ok"; value: T; payment: VerifiedPayment; settlement: SettleResponse }
  /**
   * Ідемпотентний повтор уже оплаченого запиту (умови див. VerifyResult "replay").
   * effect НЕ викликався: викликач віддає збережений результат, знайдений за `payment.id`
   * (usage_events.x402_payment_id, intros, subscriptions.last_x402_payment_id), або 409.
   */
  | { kind: "replay"; payment: StoredPayment; settlement: SettleResponse }
  | { kind: "payment_required"; response: PaymentRequiredResponse; settlement?: SettleResponse }
  /** Перевірка дії відмовила до розрахунку: нічого не списано, бронь знято. */
  | { kind: "rejected"; error: E }
  | { kind: "error"; error: GateError };

export interface PaidRequest {
  /** REST: значення заголовка PAYMENT-SIGNATURE; MCP: об'єкт `_meta["x402/payment"]`. */
  payment: unknown;
  /**
   * Перевірений вхід дії (після zod), разом з курсором чи сторінкою. З нього, назви дії й
   * URL ресурсу рахується request_hash: повтор з тим самим payment-identifier, але іншим
   * входом, дає 409, а не чужий результат.
   */
  input: unknown;
  resource: { url: string; description: string };
  context: PaymentContext;
}

export interface PaidHandlers<T, E> {
  /** Крок 4: усі перевірки дії (видимість, кулдауни, квоти, валідація). Повернути помилку, щоб відмовити. */
  validate?: (payment: VerifiedPayment) => Promise<E | null | undefined | void>;
  /**
   * Сама дія. before_effect: запускається лише після вдалого settle і запису 'settled'.
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
  /** `input`: перевірений вхід дії для request_hash (див. PaidRequest.input). */
  verify(payment: unknown, set: PaymentRequirementsSet, context: PaymentContext, input: unknown): Promise<VerifyResult>;
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
/** Межі платежу: справжній PaymentPayload має кілька сотень байтів і глибину до 6. */
const MAX_PAYMENT_BYTES = 16 * 1024;
const MAX_PAYMENT_DEPTH = 20;
/** Бронь 'verified' старша за це вважається завислою (findStalePayments). */
const STALE_VERIFIED_MINUTES = 5;
/** Паузи між спробами запису в D1 після settle: 3 спроби разом. */
const D1_RETRY_DELAYS_MS = [50, 250];

const FACILITATOR_UNAVAILABLE = "Payment facilitator is unavailable. Try again in a minute.";
const INVALID_PAYMENT = "invalid_payment: not a valid x402 v2 payment payload";

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
/** Причина від фасилітатора йде клієнту, лише якщо схожа на код протоколу. */
const REASON_CODE = /^[A-Za-z0-9_]{1,64}$/;

// ---------------------------------------------------------------------------
// Хеші

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
 * дав би новий хеш і пройшов би UNIQUE. Інші написання того самого дозволу EIP-3009
 * (регістр hex, зайві ключі) ловить другий UNIQUE: (network, evm_from, evm_nonce).
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

/** request_hash: SHA-256 (дія + канонічний перевірений вхід + URL ресурсу). */
export async function paymentRequestHash(action: PaidAction, input: unknown, resourceUrl: string): Promise<string> {
  return sha256Hex(canonicalJson({ action, input: input ?? null, resource: resourceUrl }));
}

/** Ключ дозволу EIP-3009 (from, nonce) у нижньому регістрі; null для інших схем і Solana. */
function evmAuthorizationKey(payload: PaymentPayload): { from: string; nonce: string } | null {
  if (!payload.accepted.network.startsWith("eip155:")) return null;
  const auth = payload.payload.authorization;
  if (!isRecord(auth) || typeof auth.from !== "string" || typeof auth.nonce !== "string") return null;
  return { from: auth.from.toLowerCase(), nonce: auth.nonce.toLowerCase() };
}

// ---------------------------------------------------------------------------
// Дрібні помічники

/** 'pay_' + 20 символів base62 (специфікація 3.5); спільний генератор у lib/ids.ts. */
export function newPaymentId(): string {
  return newId("pay");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Текст помилки разом з причиною (initialize ховає відповідь фасилітатора в cause). Лише для журналу. */
function errorText(error: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = error, depth = 0; e !== undefined && e !== null && depth < 3; depth++) {
    parts.push(e instanceof Error ? e.message : String(e));
    e = e instanceof Error ? e.cause : undefined;
  }
  return parts.join(": ").slice(0, 500);
}

function safeCode(reason: string | undefined, fallback: string): string {
  return reason && REASON_CODE.test(reason) ? reason : fallback;
}

/** Глибина вкладеності без рекурсії (об'єкт з MCP міг прийти будь-якої глибини). */
function withinDepth(value: unknown, max: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    if (node === null || typeof node !== "object") continue;
    if (depth > max) return false;
    for (const child of Array.isArray(node) ? node : Object.values(node)) stack.push([child, depth + 1]);
  }
  return true;
}

/**
 * Розбирає платіж з заголовка (base64) або з `_meta` MCP (об'єкт). Лише x402 v2,
 * не більше 16 КіБ і 20 рівнів вкладеності; інакше null (402 invalid_payment).
 */
export function decodePayment(input: unknown): PaymentPayload | null {
  let value = input;
  if (typeof input === "string") {
    const header = input.trim();
    // Розмір перевіряємо до розбору: JSON на 60 000 рівнів не має дійти до JSON.parse.
    if (header.length > MAX_PAYMENT_BYTES) return null;
    try {
      value = decodePaymentSignatureHeader(header);
    } catch {
      return null;
    }
  }
  if (!isRecord(value) || !withinDepth(value, MAX_PAYMENT_DEPTH)) return null;
  if (typeof input !== "string" && JSON.stringify(value).length > MAX_PAYMENT_BYTES) return null;
  if (!isPaymentPayloadV2(value) || !isRecord(value.payload)) return null;
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

/** Невдалий розрахунок для клієнта: код причини і tx, без тексту фасилітатора. */
function clientSettlement(s: SettleResponse): SettleResponse {
  return {
    success: false,
    transaction: s.transaction ?? "",
    network: s.network,
    ...(s.payer ? { payer: s.payer } : {}),
    ...(s.amount ? { amount: s.amount } : {}),
    errorReason: safeCode(s.errorReason, "settle_failed"),
  };
}

function storedSettlement(payment: StoredPayment): SettleResponse {
  return {
    success: payment.status === "settled",
    transaction: payment.tx ?? "",
    network: payment.network,
    ...(payment.payer ? { payer: payment.payer } : {}),
  };
}

// ---------------------------------------------------------------------------
// D1: повтори запису після того, як гроші пішли

function isRetryableD1Error(error: unknown): boolean {
  // 429: єдиний 4xx, яким сервер просить повторити; 5xx і обриви зв'язку теж тимчасові.
  return /\b429\b|too many requests|\b5\d\d\b|network connection lost|reset|overloaded|internal error|timed? ?out/i.test(
    errorText(error),
  );
}

async function withD1Retry<T>(write: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await write();
    } catch (error) {
      if (attempt >= D1_RETRY_DELAYS_MS.length || !isRetryableD1Error(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, D1_RETRY_DELAYS_MS[attempt]));
    }
  }
}

// ---------------------------------------------------------------------------
// Для адмінки й cron

export interface StalePayment {
  id: string;
  status: "verified" | "unconfirmed";
  action: PaidAction;
  network: Network;
  tx: string | null;
  payer: string | null;
  amountAtomic: string;
  amountUsdCents: number;
  companyId: string | null;
  channel: PaymentChannel;
  errorReason: string | null;
  createdAt: string;
}

/**
 * Платежі, які треба звірити руками: броні 'verified' старші за 5 хв (процес упав між verify
 * і settle або запис 'settled' не вдався) і всі 'unconfirmed' (settle без відповіді чи pending).
 */
export async function findStalePayments(db: D1Database, limit = 200): Promise<StalePayment[]> {
  const { results } = await db
    .prepare(
      `SELECT id, status, action, network, tx, payer, amount_atomic, amount_usd_cents, company_id, channel,
              error_reason, created_at
       FROM x402_payments
       WHERE (status = 'verified' AND created_at < datetime('now', ?1)) OR status = 'unconfirmed'
       ORDER BY created_at
       LIMIT ?2`,
    )
    .bind(`-${STALE_VERIFIED_MINUTES} minutes`, limit)
    .all<Record<string, string | number | null>>();
  return results.map((r) => ({
    id: String(r.id),
    status: r.status as StalePayment["status"],
    action: r.action as PaidAction,
    network: r.network as Network,
    tx: (r.tx as string | null) ?? null,
    payer: (r.payer as string | null) ?? null,
    amountAtomic: String(r.amount_atomic),
    amountUsdCents: Number(r.amount_usd_cents),
    companyId: (r.company_id as string | null) ?? null,
    channel: r.channel as PaymentChannel,
    errorReason: (r.error_reason as string | null) ?? null,
    createdAt: String(r.created_at),
  }));
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
  /** Набір вимог пам'ятає сервер, яким його побудовано: verify і 402 беруть той самий. */
  const setServers = new WeakMap<PaymentRequirementsSet, x402ResourceServer>();

  async function resolveServer(): Promise<x402ResourceServer> {
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
      else if (serverCache.get(cacheKey(config))?.server === pending) serverCache.delete(cacheKey(config));
      console.error("x402: facilitator /supported failed", { error: errorText(error) });
      throw new X402Error({ status: 503, code: "internal", message: FACILITATOR_UNAVAILABLE });
    }
  }

  async function serverFor(set: PaymentRequirementsSet): Promise<x402ResourceServer> {
    return setServers.get(set) ?? resolveServer();
  }

  async function buildSet(
    rs: x402ResourceServer,
    action: PaidAction,
    resource: { url: string; description: string },
  ): Promise<PaymentRequirementsSet> {
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
        console.error("x402: cannot build requirements", { network: n.network, error: errorText(error) });
        throw new X402Error({ status: 503, code: "internal", message: FACILITATOR_UNAVAILABLE });
      }
    }
    const set: PaymentRequirementsSet = {
      action,
      resource: { url: resource.url, description: resource.description, mimeType: "application/json", serviceName: SERVICE_NAME },
      accepts,
      extensions: { [PAYMENT_IDENTIFIER]: PAYMENT_IDENTIFIER_DECLARATION },
    };
    setServers.set(set, rs);
    return set;
  }

  async function requirementsFor(action: PaidAction, resource: { url: string; description: string }) {
    return buildSet(await resolveServer(), action, resource);
  }

  async function buildPaymentRequired(
    rs: x402ResourceServer,
    set: PaymentRequirementsSet,
    options: { error?: string; settlement?: SettleResponse; payload?: PaymentPayload } = {},
  ): Promise<PaymentRequiredResponse> {
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

  async function paymentRequired(
    set: PaymentRequirementsSet,
    options?: { error?: string; settlement?: SettleResponse; payload?: PaymentPayload },
  ) {
    return buildPaymentRequired(await serverFor(set), set, options);
  }

  async function release(paymentId: string): Promise<void> {
    await db.prepare("DELETE FROM x402_payments WHERE id = ?1 AND status = 'verified'").bind(paymentId).run();
  }

  async function resolveConflict(
    set: PaymentRequirementsSet,
    context: PaymentContext,
    payloadHash: string,
    requestHash: string,
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
        `SELECT id, payload_hash, request_hash, company_id, action, network, status, tx, payer, payment_identifier,
                error_reason, settled_at
         FROM x402_payments WHERE payment_identifier = ?1`,
      )
      .bind(identifier)
      .first<Record<string, string | null>>();
    // Повтор лише для того самого платежу, запиту, дії й платника (компанії чи гостя).
    if (
      !row ||
      row.payload_hash !== payloadHash ||
      row.request_hash !== requestHash ||
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
        status: row.status as PaymentStatus,
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

  async function verifyWith(
    rs: x402ResourceServer,
    input: unknown,
    set: PaymentRequirementsSet,
    context: PaymentContext,
    requestInput: unknown,
  ): Promise<VerifyResult> {
    const required = async (error: string, payload?: PaymentPayload): Promise<VerifyResult> => ({
      ok: false,
      kind: "payment_required",
      response: await buildPaymentRequired(rs, set, { error, payload }),
    });

    const payload = decodePayment(input);
    if (!payload) return required(INVALID_PAYMENT);

    const matched = rs.findMatchingRequirements(set.accepts, payload);
    if (!matched) return required("No matching payment requirements", payload);

    const echo = rs.validateExtensions(
      { x402Version: 2, resource: set.resource, accepts: set.accepts, extensions: set.extensions },
      payload,
    );
    if (!echo.valid) return required(echo.invalidReason, payload);

    const identifier = readPaymentIdentifier(payload);
    if (identifier === undefined) {
      return required("invalid_payment_identifier: id must be 16 to 128 characters of A-Z, a-z, 0-9, _ or -", payload);
    }

    const payloadHash = await paymentPayloadHash(payload);
    const requestHash = await paymentRequestHash(set.action, requestInput, set.resource.url);
    const evmKey = evmAuthorizationKey(payload);
    const paymentId = newPaymentId();
    const price = PRICES[set.action];
    // ON CONFLICT DO NOTHING спрацьовує на будь-якому UNIQUE: payload_hash, payment_identifier, (network, evm_from, evm_nonce).
    const inserted = await db
      .prepare(
        `INSERT INTO x402_payments (id, payload_hash, request_hash, payment_identifier, evm_from, evm_nonce, company_id,
           api_key_id, network, asset, pay_to, amount_atomic, amount_usd_cents, action, channel, status, facilitator, request_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 'verified', ?16, ?17)
         ON CONFLICT DO NOTHING`,
      )
      .bind(
        paymentId,
        payloadHash,
        requestHash,
        identifier,
        evmKey?.from ?? null,
        evmKey?.nonce ?? null,
        context.companyId ?? null,
        context.apiKeyId ?? null,
        matched.network,
        matched.asset,
        matched.payTo,
        matched.amount,
        price.usdCents,
        set.action,
        context.channel,
        config.enabled ? config.facilitator.kind : "cdp",
        context.requestId ?? null,
      )
      .run();
    if (inserted.meta.changes === 0) return resolveConflict(set, context, payloadHash, requestHash, identifier);

    let result: { isValid: boolean; invalidReason?: string; payer?: string };
    try {
      result = await rs.verifyPayment(payload, matched);
    } catch (error) {
      if (error instanceof VerifyError) {
        result = { isValid: false, invalidReason: error.invalidReason ?? "invalid_payment", payer: error.payer };
      } else {
        // Фасилітатор не відповів: гроші не рухались, бронь знімаємо, той самий платіж можна повторити.
        console.error("x402: facilitator verify failed", { paymentId, network: matched.network, error: errorText(error) });
        await release(paymentId);
        return {
          ok: false,
          kind: "error",
          error: { status: 503, code: "internal", message: "Payment facilitator is unavailable. Retry the same payment in a minute." },
        };
      }
    }

    if (!result.isValid) {
      const reason = result.invalidReason ?? "invalid_payment";
      await db
        .prepare(
          `UPDATE x402_payments SET status = 'failed', error_reason = ?2, payer = COALESCE(?3, payer)
           WHERE id = ?1 AND status = 'verified'`,
        )
        .bind(paymentId, reason.slice(0, 500), result.payer ?? null)
        .run();
      return required(safeCode(reason, "invalid_payment"), payload);
    }

    const payer = result.payer ?? null;
    if (payer) await db.prepare("UPDATE x402_payments SET payer = ?2 WHERE id = ?1").bind(paymentId, payer).run();
    const payment = {
      paymentId,
      action: set.action,
      payload,
      requirements: matched,
      set,
      payer,
      paymentIdentifier: identifier,
      payloadHash,
      requestHash,
    } as VerifiedPayment;
    Object.defineProperty(payment, "resourceServer", { value: rs, enumerable: false });
    return { ok: true, payment };
  }

  async function verify(payment: unknown, set: PaymentRequirementsSet, context: PaymentContext, input: unknown) {
    if (!config.enabled) return { ok: false, kind: "error", error: notConfigured } as VerifyResult;
    try {
      return await verifyWith(await serverFor(set), payment, set, context, input);
    } catch (error) {
      if (error instanceof X402Error) return { ok: false, kind: "error", error: error.gate } as VerifyResult;
      throw error;
    }
  }

  /** Записує невдалий чи непідтверджений settle; tx зберігаємо завжди, коли він є. */
  async function recordSettleFailure(
    payment: VerifiedPayment,
    status: "failed" | "unconfirmed",
    reason: string,
    tx: string,
    payer: string | null,
  ): Promise<void> {
    const text = reason.slice(0, 500);
    try {
      const stored = await withD1Retry(() =>
        db
          .prepare(
            `UPDATE OR IGNORE x402_payments SET status = ?2, error_reason = ?3, tx = ?4, payer = COALESCE(?5, payer)
             WHERE id = ?1 AND status = 'verified'`,
          )
          .bind(payment.paymentId, status, text, tx || null, payer)
          .run(),
      );
      if (stored.meta.changes === 0 && tx) {
        // tx уже належить іншому платежу (UNIQUE network, tx): лишаємо його в тексті причини.
        await withD1Retry(() =>
          db
            .prepare(
              `UPDATE x402_payments SET status = ?2, error_reason = ?3, payer = COALESCE(?4, payer)
               WHERE id = ?1 AND status = 'verified'`,
            )
            .bind(payment.paymentId, status, `${text} (tx ${tx})`.slice(0, 500), payer)
            .run(),
        );
      }
    } catch (error) {
      console.error("x402: settle outcome could not be recorded", {
        paymentId: payment.paymentId,
        status,
        network: payment.requirements.network,
        tx: tx || null,
        error: errorText(error),
      });
    }
  }

  async function settle(payment: VerifiedPayment): Promise<SettleResult> {
    const rs = payment.resourceServer;
    const network = payment.requirements.network;
    let settlement: SettleResponse;
    let internal: string | undefined;
    try {
      settlement = await rs.settlePayment(payment.payload, payment.requirements);
    } catch (error) {
      if (error instanceof SettleError) {
        settlement = {
          success: false,
          errorReason: error.errorReason ?? "settle_failed",
          ...(error.errorMessage ? { errorMessage: error.errorMessage } : {}),
          transaction: error.transaction ?? "",
          network: error.network ?? network,
          ...(error.payer ? { payer: error.payer } : {}),
        };
      } else {
        // Таймаут чи збій мережі: результат у ланцюжку невідомий.
        internal = errorText(error);
        settlement = { success: false, errorReason: "settle_unconfirmed", transaction: "", network };
      }
    }

    let status: "failed" | "unconfirmed" = "failed";
    if (internal !== undefined || settlement.errorReason === "settlement_pending") status = "unconfirmed";

    if (settlement.success && !settlement.transaction) {
      // «Успіх» без транзакції: гроші могли піти, а звірити нема за чим.
      settlement = { ...settlement, success: false, errorReason: "settle_missing_transaction" };
      status = "unconfirmed";
    }

    if (settlement.success) {
      let changes: number;
      try {
        // OR IGNORE: той самий tx уже записаний за іншим платежем (UNIQUE network, tx) → це не нова оплата.
        const updated = await withD1Retry(() =>
          db
            .prepare(
              `UPDATE OR IGNORE x402_payments
               SET status = 'settled', tx = ?2, payer = COALESCE(?3, payer), settled_at = datetime('now'), error_reason = NULL
               WHERE id = ?1 AND status = 'verified'`,
            )
            .bind(payment.paymentId, settlement.transaction, settlement.payer ?? payment.payer)
            .run(),
        );
        changes = updated.meta.changes;
      } catch (error) {
        // Гроші пішли, а запису немає: не губимо слід. Рядок лишається 'verified' → findStalePayments.
        console.error("x402: settled payment could not be recorded", {
          paymentId: payment.paymentId,
          network: settlement.network,
          tx: settlement.transaction,
          error: errorText(error),
        });
        return {
          ok: false,
          kind: "record_failed",
          paymentId: payment.paymentId,
          settlement,
          error: {
            status: 500,
            code: "internal",
            message: "Payment was received but could not be recorded. Contact support with the payment id.",
            details: { payment_id: payment.paymentId, transaction: settlement.transaction },
          },
        };
      }
      if (changes === 1) return { ok: true, paymentId: payment.paymentId, settlement };
      settlement = { ...settlement, success: false, errorReason: "duplicate_transaction" };
    }

    if (internal !== undefined || status === "unconfirmed") {
      console.error("x402: settle unconfirmed", {
        paymentId: payment.paymentId,
        network,
        tx: settlement.transaction || null,
        reason: settlement.errorReason,
        error: internal,
      });
    }
    const reason = [settlement.errorReason ?? "settle_failed", settlement.errorMessage, internal].filter(Boolean).join(": ");
    await recordSettleFailure(payment, status, reason, settlement.transaction, settlement.payer ?? null);

    const forClient = clientSettlement(settlement);
    const response = await buildPaymentRequired(rs, payment.set, {
      error: forClient.errorReason,
      settlement: forClient,
      payload: payment.payload,
    });
    return { ok: false, kind: "settle_failed", paymentId: payment.paymentId, settlement: forClient, response };
  }

  function withPayment<T, E = never>(action: PaidAction, timing: SettleTiming, handlers: PaidHandlers<T, E>) {
    return async (request: PaidRequest): Promise<PaidOutcome<T, E>> => {
      if (!config.enabled) return { kind: "error", error: notConfigured };

      // Один x402ResourceServer на весь запит: verify, settle і відповідь 402 беруть саме його.
      let rs: x402ResourceServer;
      let set: PaymentRequirementsSet;
      try {
        rs = await resolveServer();
        set = await buildSet(rs, action, request.resource);
      } catch (error) {
        if (error instanceof X402Error) return { kind: "error", error: error.gate };
        throw error;
      }

      // Крок 2: платежу немає.
      const missing = request.payment === undefined || request.payment === null || request.payment === "";
      if (missing) {
        const message = request.context.channel === "mcp" ? MCP_MISSING_PAYMENT : REST_MISSING_PAYMENT;
        return { kind: "payment_required", response: await buildPaymentRequired(rs, set, { error: message }) };
      }

      // Крок 3: verify з бронею.
      const verified = await verifyWith(rs, request.payment, set, request.context, request.input);
      if (!verified.ok) {
        if (verified.kind === "payment_required") return { kind: "payment_required", response: verified.response };
        if (verified.kind === "error") return { kind: "error", error: verified.error };
        // Ідемпотентний повтор: effect не запускаємо ніколи.
        const stored = verified.payment;
        if (stored.status === "settled") return { kind: "replay", payment: stored, settlement: storedSettlement(stored) };
        if (stored.status === "failed") {
          // Той самий платіж уже провалився: повторюємо ту саму відмову, без нової спроби.
          return {
            kind: "payment_required",
            response: await buildPaymentRequired(rs, set, { error: safeCode(stored.errorReason ?? undefined, "payment_failed") }),
          };
        }
        return {
          kind: "error",
          error: {
            status: 409,
            code: "payment_reused",
            message: "This payment is still being processed. Retry in a few seconds.",
            details: { payment_id: stored.id },
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
        // 5a: спершу гроші й запис 'settled', потім дія (сповіщення людини не відкотиш).
        const settled = await settle(payment);
        if (!settled.ok) {
          if (settled.kind === "record_failed") return { kind: "error", error: settled.error };
          return { kind: "payment_required", response: settled.response, settlement: settled.settlement };
        }
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
              details: { payment_id: payment.paymentId, transaction: settled.settlement.transaction },
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
      if (!settled.ok) {
        if (settled.kind === "record_failed") return { kind: "error", error: settled.error };
        return { kind: "payment_required", response: settled.response, settlement: settled.settlement };
      }
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
