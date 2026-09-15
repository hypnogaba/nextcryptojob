import { newId } from "@/lib/ids";
import { isoTime, sqlTime } from "@/lib/time";

/**
 * Оплата компанії на Solana (п.8, раунд 5, 15.09, РІШЕННЯ ВЛАСНИКА: лише Solana, Stripe не
 * потрібен). Людина сканує QR чи тисне посилання гаманця (Solana Pay, специфікація
 * https://docs.solanapay.com/spec), платить 100 USDC з ВЛАСНОГО гаманця на адресу власника
 * (NCJ_PAY_ADDRESS, лише публічна адреса, ключів на нашому боці немає). Ми звіряємо оплату
 * в мережі через JSON-RPC (SOLANA_RPC_URL, повний Helius-подібний URL) за унікальним `reference`
 * кожного рахунку: getSignaturesForAddress(reference), потім getTransaction (jsonParsed), звіряємо
 * мінт USDC і те, що USDC-баланс власника зріс щонайменше на суму рахунку (postTokenBalances
 * проти preTokenBalances для власника адреси, не для гаманця платника, який ми не знаємо наперед).
 *
 * Підтверджений рахунок дає рядок `subscriptions` (provider='usdc', 30 днів, стається в чергу з
 * x402 USDC-місяцями buyUsdcMonth: те саме подання доступу company_access, 0012, не розрізняє
 * походження). `solana_pay_invoices` (0025) лише слід рахунку: reference, статус, хто підтвердив.
 */

export const SOLANA_PAY_AMOUNT_USDC = 100;
export const SOLANA_PAY_MONTH_DAYS = 30;
/** За стільки днів до кінця оплаченого періоду нагадати (lib/cron/billing-reminders.ts). */
export const SOLANA_PAY_REMINDER_DAYS = 3;
/** Рахунок, який довше не підтвердився, більше не рахуємо «pending» на очах у людини (cron все одно спробує востаннє). */
export const SOLANA_PAY_INVOICE_TTL_MINUTES = 60;

/** USDC на mainnet-beta (адреса з завдання, та сама, що X402_PAY_TO_SOLANA дивиться зі свого mint). */
export const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export interface SolanaPayEnv {
  /** Публічна адреса власника, яка приймає оплату. Wrangler var, не секрет. */
  NCJ_PAY_ADDRESS?: string;
  /** Повний URL постачальника JSON-RPC (Helius чи інший), Worker secret. */
  SOLANA_RPC_URL?: string;
}

export type SolanaPayConfig = { enabled: true; payTo: string; rpcUrl: string } | { enabled: false; reason: string; missing: string[] };

function clean(v: string | undefined): string | undefined {
  const s = v?.trim();
  return s ? s : undefined;
}

/** Та сама форма адреси, що x402/config.ts SOLANA_ADDRESS: base58, 32-44 символи. */
const SOLANA_ADDRESS_SHAPE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Налаштування Solana Pay з оточення Worker; без адреси чи RPC вимкнено, причина називає, чого бракує. */
export function readSolanaPayConfig(env: SolanaPayEnv): SolanaPayConfig {
  const payTo = clean(env.NCJ_PAY_ADDRESS);
  const rpcUrl = clean(env.SOLANA_RPC_URL);
  const missing: string[] = [];
  if (!payTo) missing.push("NCJ_PAY_ADDRESS");
  else if (!SOLANA_ADDRESS_SHAPE.test(payTo)) missing.push("NCJ_PAY_ADDRESS (invalid address)");
  if (!rpcUrl) missing.push("SOLANA_RPC_URL");
  if (missing.length > 0) return { enabled: false, reason: `not configured: ${missing.join(", ")}`, missing };
  return { enabled: true, payTo: payTo!, rpcUrl: rpcUrl! };
}

// ---------------------------------------------------------------------------
// base58 (Bitcoin/Solana alphabet): лише для reference (32 випадкові байти, не ключ)
// і для звірення довжини адрес у тестах. Без зовнішньої залежності: маленький,
// стандартний алгоритм, ніякої криптографії, самі великі числа в base 58.

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map([...BASE58_ALPHABET].map((c, i) => [c, i]));

export function base58Encode(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! * 256;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let leadingZeros = 0;
  for (const byte of bytes) {
    if (byte !== 0) break;
    leadingZeros++;
  }
  return BASE58_ALPHABET[0]!.repeat(leadingZeros) + digits.reverse().map((d) => BASE58_ALPHABET[d]!).join("");
}

/** Обернене до base58Encode; кидає на символі поза абеткою. Лише для тестів і звірення довжини. */
export function base58Decode(s: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of s) {
    const value = BASE58_INDEX.get(char);
    if (value === undefined) throw new Error(`base58Decode: "${char}" is not in the alphabet`);
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingOnes = 0;
  for (const char of s) {
    if (char !== BASE58_ALPHABET[0]) break;
    leadingOnes++;
  }
  return new Uint8Array([...new Array(leadingOnes).fill(0), ...bytes.reverse()]);
}

/** Новий, випадковий, одноразовий reference (32 байти, base58): не ключ, лише мітка транзакції. */
export function randomReference(): string {
  return base58Encode(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * Посилання Solana Pay (специфікація transfer request): гаманець сам будує переказ SPL-токена
 * до `payTo` на суму `amount` USDC, кладучи `reference` звичайним (не підписувачем) обліковим
 * записом у транзакцію, тож ми знаходимо її через getSignaturesForAddress(reference).
 */
export function solanaPayUrl(o: { payTo: string; amount: number; reference: string; label: string; message: string }): string {
  const params = new URLSearchParams({
    amount: String(o.amount),
    "spl-token": USDC_MINT_MAINNET,
    reference: o.reference,
    label: o.label,
    message: o.message,
  });
  return `solana:${o.payTo}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Рахунок (0025 solana_pay_invoices)

export type InvoiceStatus = "pending" | "confirmed" | "expired";

export interface SolanaPayInvoice {
  id: string;
  companyId: string;
  reference: string;
  amountUsdc: number;
  status: InvoiceStatus;
  tx: string | null;
  payer: string | null;
  subscriptionId: string | null;
  createdAt: string;
  confirmedAt: string | null;
  expiresAt: string;
}

type InvoiceRow = {
  id: string;
  company_id: string;
  reference: string;
  amount_usdc: number;
  status: InvoiceStatus;
  tx: string | null;
  payer: string | null;
  subscription_id: string | null;
  created_at: string;
  confirmed_at: string | null;
  expires_at: string;
};

function fromRow(r: InvoiceRow): SolanaPayInvoice {
  return {
    id: r.id, companyId: r.company_id, reference: r.reference, amountUsdc: r.amount_usdc, status: r.status,
    tx: r.tx, payer: r.payer, subscriptionId: r.subscription_id,
    createdAt: isoTime(r.created_at), confirmedAt: r.confirmed_at ? isoTime(r.confirmed_at) : null, expiresAt: isoTime(r.expires_at),
  };
}

/** Новий рахунок на 100 USDC, reference унікальний (UNIQUE ловить теоретичне зіткнення, і так вкрай малоймовірне: 2^256 варіантів). */
export async function createInvoice(db: D1Database, companyId: string, createdBy: string | null, now: Date): Promise<SolanaPayInvoice> {
  const id = newId("spi");
  const reference = randomReference();
  const expiresAt = sqlTime(new Date(now.getTime() + SOLANA_PAY_INVOICE_TTL_MINUTES * 60_000));
  await db
    .prepare(
      `INSERT INTO solana_pay_invoices (id, company_id, reference, amount_usdc, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, companyId, reference, SOLANA_PAY_AMOUNT_USDC, createdBy, sqlTime(now), expiresAt)
    .run();
  return { id, companyId, reference, amountUsdc: SOLANA_PAY_AMOUNT_USDC, status: "pending", tx: null, payer: null,
    subscriptionId: null, createdAt: isoTime(sqlTime(now)), confirmedAt: null, expiresAt: isoTime(expiresAt) };
}

export async function loadInvoice(db: D1Database, companyId: string, id: string): Promise<SolanaPayInvoice | null> {
  const row = await db
    .prepare("SELECT * FROM solana_pay_invoices WHERE id = ? AND company_id = ?")
    .bind(id, companyId)
    .first<InvoiceRow>();
  return row ? fromRow(row) : null;
}

// ---------------------------------------------------------------------------
// Перевірка в мережі (JSON-RPC)

interface RpcCaller {
  (method: string, params: unknown[]): Promise<unknown>;
}

/** Один виклик JSON-RPC на rpcUrl; кидає з коротким описом на HTTP-збій чи помилку RPC. */
function rpcCaller(rpcUrl: string, fetchImpl: typeof fetch = fetch): RpcCaller {
  let id = 0;
  return async (method, params) => {
    id++;
    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (!res.ok) throw new Error(`solana rpc: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message?: string; code?: number } };
    if (body.error) throw new Error(`solana rpc: ${body.error.message ?? "error"} (${body.error.code ?? "?"})`);
    return body.result;
  };
}

type SigStatus = { signature: string; err: unknown };
type TokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } };
type GetTransactionResult = {
  transaction?: { message?: { accountKeys?: Array<{ pubkey: string; signer?: boolean }> } };
  meta?: { err: unknown; preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[] };
} | null;

export type VerifyResult =
  | { status: "confirmed"; tx: string; payer: string | null }
  | { status: "pending" }
  | { status: "error"; reason: string };

/**
 * Звіряє один рахунок у мережі: getSignaturesForAddress(reference) (найновіші спершу), потім для
 * кожної не-провальної підписи getTransaction (jsonParsed) аж поки не знайдеться така, де USDC-баланс
 * `payTo` зріс щонайменше на `amountUsdc`. Немає жодної відповідної підписи: 'pending', а не помилка
 * (людина ще не заплатила чи гаманець ще не розповсюдив транзакцію). RPC відповів помилкою: 'error',
 * без зміни статусу рахунку (наступний спроба, cron чи «Check now», повторить).
 */
export async function verifyOnChain(
  rpcUrl: string, reference: string, payTo: string, amountUsdc: number, fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult> {
  const call = rpcCaller(rpcUrl, fetchImpl);
  let sigs: SigStatus[];
  try {
    sigs = (await call("getSignaturesForAddress", [reference, { limit: 10 }])) as SigStatus[];
  } catch (e) {
    return { status: "error", reason: e instanceof Error ? e.message : "getSignaturesForAddress failed" };
  }
  const ok = sigs.filter((s) => !s.err);
  if (ok.length === 0) return { status: "pending" };

  const required = BigInt(Math.round(amountUsdc * 1_000_000)); // USDC: 6 знаків
  for (const s of ok) {
    let tx: GetTransactionResult;
    try {
      tx = (await call("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }])) as GetTransactionResult;
    } catch (e) {
      return { status: "error", reason: e instanceof Error ? e.message : "getTransaction failed" };
    }
    if (!tx || tx.meta?.err) continue;
    const pre = tx.meta?.preTokenBalances ?? [];
    const post = tx.meta?.postTokenBalances ?? [];
    const preOwner = pre.find((b) => b.mint === USDC_MINT_MAINNET && b.owner === payTo);
    const postOwner = post.find((b) => b.mint === USDC_MINT_MAINNET && b.owner === payTo);
    if (!postOwner) continue; // ця транзакція не чіпає гаманець власника: не наш платіж
    const before = preOwner ? BigInt(preOwner.uiTokenAmount.amount) : BigInt(0);
    const after = BigInt(postOwner.uiTokenAmount.amount);
    if (after - before < required) continue; // менше за суму рахунку: не рахуємо (недоплата)

    // Платник: рахунок USDC із від'ємною зміною, інакше перший підписувач транзакції.
    const senderBalance = pre.find((b) => b.mint === USDC_MINT_MAINNET && b.owner !== payTo && b.owner);
    const payer = senderBalance?.owner ?? tx.transaction?.message?.accountKeys?.find((k) => k.signer)?.pubkey ?? null;
    return { status: "confirmed", tx: s.signature, payer };
  }
  return { status: "pending" };
}

// ---------------------------------------------------------------------------
// Підтвердження: рахунок -> subscriptions (як buyUsdcMonth, lib/billing/usdc.ts)

export interface ConfirmedMonth {
  subscriptionId: string;
  periodEnd: string;
}

/** Рахунок уже підтверджений раніше (повторний виклик cron чи «Check now» після успіху): та сама відповідь, новий рядок не пишеться. */
export async function findConfirmedMonth(db: D1Database, invoiceId: string): Promise<ConfirmedMonth | null> {
  const row = await db
    .prepare(
      `SELECT s.id, s.current_period_end FROM solana_pay_invoices i JOIN subscriptions s ON s.id = i.subscription_id
        WHERE i.id = ? AND i.subscription_id IS NOT NULL`,
    )
    .bind(invoiceId)
    .first<{ id: string; current_period_end: string }>();
  return row ? { subscriptionId: row.id, periodEnd: isoTime(row.current_period_end) } : null;
}

/**
 * Рахунок підтверджений у мережі -> один рядок subscriptions (provider='usdc', 30 днів, стається
 * після чинного USDC-періоду, як x402 buyUsdcMonth) і сам рахунок стає 'confirmed'. Ідемпотентно:
 * `solana_pay_invoices.subscription_id IS NOT NULL` означає, що це вже зроблено (findConfirmedMonth).
 */
export async function confirmInvoice(db: D1Database, invoice: SolanaPayInvoice, tx: string, payer: string | null, now: Date): Promise<ConfirmedMonth> {
  const already = await findConfirmedMonth(db, invoice.id);
  if (already) return already;

  const subId = newId("sub");
  const nowSql = sqlTime(now);
  await db.batch([
    db
      .prepare(
        `INSERT INTO subscriptions (id, company_id, provider, plan, status, current_period_start, current_period_end,
                                    currency, amount_cents, created_at, updated_at)
         SELECT ?1, ?2, 'usdc', 'company_monthly', 'active', p.start, datetime(p.start, ?3), 'usdc', ?4, ?5, ?5
           FROM (SELECT MAX(?5, COALESCE((SELECT MAX(current_period_end) FROM subscriptions
                                           WHERE company_id = ?2 AND provider = 'usdc' AND status = 'active'), ?5)) AS start) p`,
      )
      .bind(subId, invoice.companyId, `+${SOLANA_PAY_MONTH_DAYS} days`, SOLANA_PAY_AMOUNT_USDC * 100, nowSql),
    db
      .prepare(`UPDATE solana_pay_invoices SET status = 'confirmed', tx = ?, payer = ?, subscription_id = ?, confirmed_at = ? WHERE id = ?`)
      .bind(tx, payer, subId, nowSql, invoice.id),
  ]);
  const month = await findConfirmedMonth(db, invoice.id);
  if (!month) throw new Error("solana pay: subscription row missing right after insert");
  return month;
}

/** Rахунки, чекаючи довше за SOLANA_PAY_INVOICE_TTL_MINUTES, більше не варті перевірки в мережі (cron.ts). */
export async function expireStaleInvoices(db: D1Database, now: Date): Promise<number> {
  const res = await db
    .prepare(`UPDATE solana_pay_invoices SET status = 'expired' WHERE status = 'pending' AND expires_at < ?`)
    .bind(sqlTime(now))
    .run();
  return res.meta.changes ?? 0;
}

/** Рахунки, ще pending і не прострочені: cron перевіряє їх у мережі (checkPendingInvoices, самий cron сам). */
export async function listPendingInvoices(db: D1Database, now: Date, limit: number): Promise<SolanaPayInvoice[]> {
  const { results } = await db
    .prepare(`SELECT * FROM solana_pay_invoices WHERE status = 'pending' AND expires_at >= ? ORDER BY created_at LIMIT ?`)
    .bind(sqlTime(now), limit)
    .all<InvoiceRow>();
  return results.map(fromRow);
}
