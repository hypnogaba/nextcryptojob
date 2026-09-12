import { vi } from "vitest";
import type { ActionContext, CrmEnv } from "@/lib/crm/context";
import { runAction, type ActionResult } from "@/lib/crm/actions";
import type { Intro } from "@/lib/crm/types";
import { addApiKey, addCompany, addMember, addScore, addSubscription, addUser, contextFor, run, TEST_ENV, type UserOpts } from "./crm-fixtures";
import type { TestDb } from "./sqlite-d1";

/**
 * Знайомства в тестах: мережа на заглушці (Bot API, фасилітатор x402), пошта
 * на заглушці binding EMAIL, компанія з власником і ключем, кандидат з
 * Telegram. Лише Node, у Worker не імпортувати.
 */

export const NOW = new Date("2026-09-12T12:00:00Z");
export const BOT_TOKEN = "123456:test-bot-token";
export const MESSAGE = "We are hiring a Solidity engineer for our lending protocol. Open to a 20 minute call?";
export const PAYER = "0x2222222222222222222222222222222222222222";

export interface TgCall {
  method: string;
  payload: Record<string, unknown>;
}

export interface SentMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Network {
  tg: TgCall[];
  /** chat_id, яким бот не може писати (людина заблокувала бота). */
  blockedChats: Set<string>;
  mail: SentMail[];
  mailFails: boolean;
  verify: number;
  settle: number;
  settleOk: boolean;
  /** Повідомлення бота одній людині (sendMessage у її чат). */
  messagesTo(chatId: string): TgCall[];
}

/** Заглушка fetch: Bot API і фасилітатор x402 (x402.org у розробці). */
export function stubNetwork(): Network {
  const net: Network = {
    tg: [],
    blockedChats: new Set(),
    mail: [],
    mailFails: false,
    verify: 0,
    settle: 0,
    settleOk: true,
    messagesTo(chatId) {
      return this.tg.filter((c) => c.method === "sendMessage" && String(c.payload.chat_id) === chatId);
    },
  };
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.telegram.org/")) {
      const method = url.split("/").at(-1)!;
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      net.tg.push({ method, payload });
      if (method === "sendMessage" && net.blockedChats.has(String(payload.chat_id))) {
        return Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, { status: 403 });
      }
      return Response.json({ ok: true, result: {} });
    }
    if (url.endsWith("/supported")) {
      return Response.json({
        kinds: [
          { x402Version: 2, scheme: "exact", network: "eip155:84532" },
          {
            x402Version: 2,
            scheme: "exact",
            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
            extra: { feePayer: "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5" },
          },
        ],
        extensions: [],
        signers: {},
      });
    }
    const body = JSON.parse(String(init?.body));
    if (url.endsWith("/verify")) {
      net.verify++;
      return Response.json({ isValid: true, payer: PAYER });
    }
    if (url.endsWith("/settle")) {
      net.settle++;
      return net.settleOk
        ? Response.json({ success: true, transaction: `0xtx${net.settle}`, network: body.paymentRequirements.network, payer: PAYER })
        : Response.json({ success: false, errorReason: "insufficient_funds", transaction: "", network: body.paymentRequirements.network });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return net;
}

/** binding EMAIL на заглушці: листи падають у net.mail або кидають, коли net.mailFails. */
export function fakeEmail(net: Network): SendEmail {
  return {
    async send(message: { to: string; subject: string; text: string; html: string }) {
      if (net.mailFails) throw new Error("E_RECIPIENT_SUPPRESSED: delivery to someone@example.com refused");
      net.mail.push({ to: message.to, subject: message.subject, text: message.text, html: message.html });
      return { messageId: `m${net.mail.length}` };
    },
  } as unknown as SendEmail;
}

export function introEnv(net: Network, extra: Partial<CrmEnv> = {}): CrmEnv {
  return {
    ...TEST_ENV,
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    EMAIL: fakeEmail(net),
    SITE_URL: "https://nextcryptojob.xyz",
    X402_PAY_TO_EVM: "0x1111111111111111111111111111111111111111",
    X402_PAY_TO_SOLANA: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    ...extra,
  } as CrmEnv;
}

let telegramSeq = 7_000_000;
export function nextTelegramId(): string {
  telegramSeq++;
  return String(telegramSeq);
}

/** Прив'язати Telegram і канал до людини. */
export function linkTelegram(db: TestDb, userId: string, telegramId: string, channel: "telegram" | "email" = "telegram"): void {
  run(db.raw, "UPDATE users SET telegram_id = ?, channel = ? WHERE id = ?", telegramId, channel, userId);
}

export interface CandidateOpts extends UserOpts {
  /** Telegram id (чат бота); null = без Telegram. Типово новий id. */
  telegramId?: string | null;
  channel?: "telegram" | "email";
}

/** Видимий кандидат з балом інженера, Telegram-ніком @alice_eth і поштою. */
export function addCandidate(db: TestDb, o: CandidateOpts = {}): { id: string; telegramId: string | null } {
  const id = addUser(db.raw, {
    telegram: "alice_eth",
    ...o,
    email: o.email === undefined ? `alice.${crypto.randomUUID().slice(0, 6)}@gmail.com` : o.email,
  });
  addScore(db.raw, id, "engineer", 72);
  const telegramId = o.telegramId === undefined ? nextTelegramId() : o.telegramId;
  if (telegramId) linkTelegram(db, id, telegramId, o.channel ?? "telegram");
  else if (o.channel) run(db.raw, "UPDATE users SET channel = ? WHERE id = ?", o.channel, id);
  return { id, telegramId };
}

export interface TestCompany {
  co: string;
  ownerId: string;
  ownerTelegram: string;
  keyId: string;
  /** Ключ API (агент), канал rest. */
  agent: ActionContext;
  /** Власник у вебі (сесія). */
  owner: ActionContext;
}

export async function addTestCompany(
  db: TestDb,
  net: Network,
  o: { name?: string; kind?: "company" | "agency"; subscribed?: boolean; now?: Date; domain?: string; env?: Partial<CrmEnv> } = {},
): Promise<TestCompany> {
  const co = addCompany(db.raw, { name: o.name ?? "Acme Labs", kind: o.kind ?? "company" });
  if (o.domain) run(db.raw, "UPDATE companies SET domain = ?, domain_verified_at = datetime('now') WHERE id = ?", o.domain, co);
  if (o.subscribed ?? true) addSubscription(db.raw, co);
  const ownerId = addUser(db.raw, { visible: false, email: `dana.${co.slice(3, 9).toLowerCase()}@acme.io` });
  const ownerTelegram = nextTelegramId();
  linkTelegram(db, ownerId, ownerTelegram);
  addMember(db.raw, co, ownerId, "owner");
  const { id: keyId, key } = await addApiKey(db.raw, co, { name: "sourcing-bot" });
  const env = introEnv(net, o.env);
  return {
    co,
    ownerId,
    ownerTelegram,
    keyId,
    agent: await contextFor(db, { authorization: `Bearer ${key}` }, { now: o.now ?? NOW, env }),
    owner: await contextFor(db, { sessionUserId: ownerId }, { now: o.now ?? NOW, env }),
  };
}

/** Запит на знайомство через реєстр (як інтерфейс чи REST з підпискою). */
export async function ask(
  ctx: ActionContext,
  candidateId: string,
  extra: Record<string, unknown> = {},
): Promise<ActionResult & { output: Intro }> {
  return (await runAction("request_intro", { candidate_id: candidateId, message: MESSAGE, ...extra }, ctx)) as ActionResult & {
    output: Intro;
  };
}

export async function rejection(p: Promise<unknown>): Promise<{ code: string; status: number; message: string; details?: Record<string, unknown> }> {
  try {
    await p;
  } catch (e) {
    return e as { code: string; status: number; message: string; details?: Record<string, unknown> };
  }
  throw new Error("expected a rejection");
}

/** Токен з листа запиту (посилання /intro/{id}?t=…). */
export function tokenFromMail(mail: SentMail): string {
  const m = /\/intro\/int_[A-Za-z0-9]{20}\?t=([A-Za-z0-9_-]{43})/.exec(mail.text);
  if (!m) throw new Error("no review link in the email");
  return m[1];
}
