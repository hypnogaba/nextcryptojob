import { cookies, headers } from "next/headers";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { telegramEnv } from "@/lib/telegram/env";
import { clientIp, consume, type Limits } from "./ratelimit";
import { createSession, currentUser } from "./session";
import {
  authorizationUrl,
  callbackUrl,
  clearedFlowCookieOptions,
  decodeFlow,
  encodeFlow,
  exchangeCode,
  FLOW_COOKIE,
  flowCookieOptions,
  newFlow,
  OidcError,
  oidcClient,
  stateMatches,
  verifyIdToken,
  type TelegramIdentity,
} from "./telegram-oidc";
import { homeFor, linkTelegram, signInWithTelegram } from "./telegram-user";

/**
 * Два кроки входу через Telegram для Route Handler'ів /auth/telegram/start і
 * /auth/telegram/callback. Тут куки, сесія й база; криптографія в telegram-oidc.ts.
 */

/** Причини, які показує /auth/telegram/error. Лише ці ключі, жодного тексту з запиту. */
export const TELEGRAM_ERRORS = {
  unavailable: "Telegram sign-in opens soon. Use email for now.",
  expired: "This sign-in link has expired or was opened in another browser. Try again.",
  cancelled: "Telegram sign-in was cancelled.",
  failed: "We could not sign you in with Telegram. Try again.",
  rate_limited: "Too many sign-in attempts. Try again in an hour.",
  linked_elsewhere: "This Telegram account is linked to another profile.",
  other_telegram: "Your profile is already linked to a different Telegram account.",
  session_changed: "Your session changed while you were connecting Telegram. Sign in again, then connect Telegram from your account.",
  cross_site: "To connect Telegram, open your account page on this site and press Connect Telegram there.",
} as const;
export type TelegramErrorReason = keyof typeof TELEGRAM_ERRORS;

export function isTelegramErrorReason(value: unknown): value is TelegramErrorReason {
  return typeof value === "string" && Object.hasOwn(TELEGRAM_ERRORS, value);
}

export function errorPath(reason: TelegramErrorReason): string {
  return `/auth/telegram/error?reason=${reason}`;
}

/** Обміни коду з однієї адреси IP: 30 за годину. Кожен обмін іде в Telegram з нашим секретом клієнта. */
export const TELEGRAM_CALLBACK_IP_LIMITS: Limits = { windowMinutes: 60, maxAttempts: 30, blockMinutes: 60 };

type Deps = {
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  nowSeconds?: number;
  keyFor?: (kid: string) => Promise<CryptoKey>;
};

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Крок 1: кука стану й адреса Telegram, куди перенаправити людину. null, якщо
 * ключів OIDC ще немає. Хто вже ввійшов, той прив'язує Telegram до свого профілю.
 *
 * Прив'язку починаємо лише з нашого ж сайту: якщо браузер каже, що перехід
 * прийшов з чужого (Sec-Fetch-Site: cross-site), замість Telegram віддаємо
 * адресу сторінки помилки. Чужа сторінка не має запускати прив'язку до профілю
 * людини, що ввійшла. Без заголовка (старі браузери) пускаємо: state і PKCE
 * все одно не дають підкласти чужий вхід. Звичайний вхід без сесії приймаємо
 * звідки завгодно.
 */
export async function beginTelegramLogin(origin: string, deps: Deps = {}): Promise<string | null> {
  const client = oidcClient(telegramEnv());
  if (!client) return null;
  const user = await currentUser();
  if (user && (await headers()).get("sec-fetch-site") === "cross-site") {
    console.warn("telegram link refused: cross-site start");
    return new URL(errorPath("cross_site"), origin).toString();
  }
  const flow = newFlow(user?.id ?? null, deps.nowSeconds ?? nowSec());
  (await cookies()).set(FLOW_COOKIE, encodeFlow(flow), flowCookieOptions());
  return authorizationUrl(client, callbackUrl(origin), flow);
}

/**
 * Крок 2: повернення від Telegram. Віддає шлях, куди перенаправити людину.
 *
 * Порядок має значення: кука стану одноразова (стирається першою), state
 * перевіряється до будь-якого запиту в мережу, а сесія ставиться останньою,
 * після запису в журнал.
 */
export async function finishTelegramLogin(params: URLSearchParams, origin: string, deps: Deps = {}): Promise<string> {
  const now = deps.nowSeconds ?? nowSec();
  const jar = await cookies();
  const raw = jar.get(FLOW_COOKIE)?.value;
  jar.set(FLOW_COOKIE, "", clearedFlowCookieOptions());

  const client = oidcClient(telegramEnv());
  if (!client) return errorPath("unavailable");

  const flow = decodeFlow(raw, now);
  if (!flow || !stateMatches(flow, params.get("state"))) return errorPath("expired");

  // Людина натиснула «Cancel» у Telegram або Telegram відмовив.
  const oauthError = params.get("error");
  if (oauthError) return errorPath(oauthError === "access_denied" ? "cancelled" : "failed");

  const code = params.get("code");
  if (!code || code.length > 2048) return errorPath("failed");

  const limit = await consume(`tg-login:ip:${clientIp(await headers())}`, TELEGRAM_CALLBACK_IP_LIMITS);
  if (!limit.allowed) return errorPath("rate_limited");

  let identity: TelegramIdentity;
  try {
    const idToken = await exchangeCode(
      client,
      { code, verifier: flow.verifier, redirectUri: callbackUrl(origin) },
      deps.fetchImpl,
    );
    identity = await verifyIdToken(idToken, {
      clientId: client.clientId,
      nonce: flow.nonce,
      nowSeconds: now,
      keyFor: deps.keyFor,
    });
  } catch (err) {
    if (err instanceof OidcError) {
      console.warn(`telegram oidc: ${err.message}`);
      return errorPath("failed");
    }
    throw err;
  }

  const d = db();
  const session = await currentUser();

  // Сесія мусить бути тією самою, що на старті. Кнопку натискали з сесією, а
  // повернулись без неї чи з іншою: прив'язувати нема до кого. Натискали без
  // сесії, а тепер вона є (хтось увійшов у цьому браузері, поки людина була в
  // Telegram): не прив'язуємо цей Telegram до профілю, якого людина не обирала.
  if ((session?.id ?? null) !== flow.linkUserId) return errorPath("session_changed");

  if (session) {
    const result = await linkTelegram(d, session.id, identity);
    switch (result) {
      case "linked":
        await audit(session.id, "auth.telegram_linked", session.id);
        return "/account";
      case "already_linked":
        return "/account";
      case "taken":
        await audit(session.id, "auth.telegram_link_conflict", session.id);
        return errorPath("linked_elsewhere");
      case "has_other_telegram":
        return errorPath("other_telegram");
    }
  }

  const { userId, created } = await signInWithTelegram(d, identity);
  // Журнал до сесії: якщо запис упаде, людина не лишиться з кукою й помилкою водночас.
  await audit(userId, "auth.login_telegram", userId, { created });
  await createSession(userId, "telegram");
  return created ? "/welcome" : homeFor(d, userId);
}
