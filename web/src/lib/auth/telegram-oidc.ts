import type { TelegramEnv } from "@/lib/telegram/env";
import { randomToken, safeEqual } from "./hash";

/**
 * «Log In with Telegram» за OpenID Connect: код авторизації з PKCE (S256).
 * Джерело: https://core.telegram.org/bots/telegram-login і документ
 * https://oauth.telegram.org/.well-known/openid-configuration (звірено 2026-09-12).
 *
 * - Токен: POST /token, client_secret_basic (Basic base64(client_id:client_secret)).
 * - ID-токен RS256, ключі з JWKS; iss = https://oauth.telegram.org, aud = Client ID
 *   (він же id бота). UserInfo немає: усе, що треба, лежить у самому ID-токені.
 * - `sub` НЕ є id людини в Telegram. Id лежить у claim `id` (scope profile), і
 *   саме він потрібен боту як chat_id. Нік: `preferred_username`, ім'я: `name`.
 * - scope telegram:bot_access дозволяє боту писати людині після входу.
 *
 * Старий віджет з HMAC Telegram вважає застарілим, його тут немає.
 *
 * Модуль чистий: мережа лише через переданий fetch, час лише через параметр,
 * тож тест перевіряє все з локальним ключем RSA і підставними відповідями.
 */

export const TELEGRAM_ISSUER = "https://oauth.telegram.org";
export const AUTHORIZATION_ENDPOINT = `${TELEGRAM_ISSUER}/auth`;
export const TOKEN_ENDPOINT = `${TELEGRAM_ISSUER}/token`;
export const JWKS_URI = `${TELEGRAM_ISSUER}/.well-known/jwks.json`;
export const SCOPES = "openid profile telegram:bot_access";

/** Шлях повернення від Telegram. Такий самий треба внести в BotFather. */
export const CALLBACK_PATH = "/auth/telegram/callback";

/**
 * Кука стану входу: state, PKCE verifier і nonce, 10 хвилин.
 * Префікс __Host- забороняє ставити її з піддомену чи без https: той, хто
 * підклав би свою куку, міг би прив'язати свій Telegram до чужого профілю.
 */
export const FLOW_COOKIE = "__Host-ncj_tg_oidc";
export const FLOW_TTL_SECONDS = 10 * 60;

/** Допуск розбіжності годинників для exp і iat. */
const CLOCK_SKEW_SECONDS = 60;
/**
 * ID-токен, виданий раніше за 10 хвилин, не приймаємо, хоч би що казав exp:
 * стільки ж живе кука стану, а токен ми отримуємо одразу після повернення.
 */
export const MAX_TOKEN_AGE_SECONDS = 10 * 60;
const TOKEN_TIMEOUT_MS = 8_000;

export type OidcClient = { clientId: string; clientSecret: string };

/** Клієнт OIDC або null, якщо власник ще не додав ключі (тоді кнопку ховаємо). */
export function oidcClient(env: TelegramEnv): OidcClient | null {
  const clientId = env.TELEGRAM_OIDC_CLIENT_ID;
  const clientSecret = env.TELEGRAM_OIDC_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function telegramLoginEnabled(env: TelegramEnv): boolean {
  return oidcClient(env) !== null;
}

export function callbackUrl(origin: string): string {
  return new URL(CALLBACK_PATH, origin).toString();
}

// ── Стан входу (кука) ─────────────────────────────────────────────────────

export type OidcFlow = {
  state: string;
  verifier: string;
  nonce: string;
  /** Секунди Unix, коли людина натиснула кнопку. */
  issuedAt: number;
  /** Хто натиснув «Connect Telegram» у кабінеті; null для звичайного входу. */
  linkUserId: string | null;
};

export function newFlow(linkUserId: string | null, nowSeconds: number): OidcFlow {
  return { state: randomToken(), verifier: randomToken(), nonce: randomToken(), issuedAt: nowSeconds, linkUserId };
}

export function flowCookieOptions() {
  return { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/", maxAge: FLOW_TTL_SECONDS };
}

/** Прибрати куку. Для __Host- потрібні ті самі Secure і Path, інакше браузер відкине заголовок. */
export function clearedFlowCookieOptions() {
  return { ...flowCookieOptions(), maxAge: 0 };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function b64FromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64urlFromBytes(bytes: Uint8Array): string {
  return b64FromBytes(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesFromB64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function encodeFlow(flow: OidcFlow): string {
  return b64urlFromBytes(encoder.encode(JSON.stringify(flow)));
}

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Кука назад у стан; усе, що не має точної форми або прострочене, дає null. */
export function decodeFlow(raw: string | undefined, nowSeconds: number): OidcFlow | null {
  if (!raw || raw.length > 1024) return null;
  const bytes = bytesFromB64url(raw);
  if (!bytes) return null;
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  const f = value as Partial<OidcFlow>;
  if (
    typeof f !== "object" ||
    f === null ||
    typeof f.state !== "string" ||
    !TOKEN_SHAPE.test(f.state) ||
    typeof f.verifier !== "string" ||
    !TOKEN_SHAPE.test(f.verifier) ||
    typeof f.nonce !== "string" ||
    !TOKEN_SHAPE.test(f.nonce) ||
    typeof f.issuedAt !== "number" ||
    !(f.linkUserId === null || (typeof f.linkUserId === "string" && f.linkUserId.length <= 64))
  ) {
    return null;
  }
  if (nowSeconds - f.issuedAt > FLOW_TTL_SECONDS || f.issuedAt - nowSeconds > CLOCK_SKEW_SECONDS) return null;
  return { state: f.state, verifier: f.verifier, nonce: f.nonce, issuedAt: f.issuedAt, linkUserId: f.linkUserId };
}

/** Чи повернувся той самий state, що лежить у куці цього браузера (захист від CSRF). */
export function stateMatches(flow: OidcFlow, returned: string | null): boolean {
  return typeof returned === "string" && safeEqual(returned, flow.state);
}

// ── Запит авторизації ─────────────────────────────────────────────────────

/** PKCE S256: base64url(SHA-256(verifier)). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return b64urlFromBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
}

export async function authorizationUrl(client: OidcClient, redirectUri: string, flow: OidcFlow): Promise<string> {
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", flow.state);
  url.searchParams.set("nonce", flow.nonce);
  url.searchParams.set("code_challenge", await pkceChallenge(flow.verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

// ── Помилки ───────────────────────────────────────────────────────────────

export type OidcFailure =
  | "token_exchange"
  | "malformed_token"
  | "unsupported_alg"
  | "jwks_unavailable"
  | "unknown_key"
  | "bad_signature"
  | "wrong_issuer"
  | "wrong_audience"
  | "expired"
  | "issued_in_future"
  | "too_old"
  | "wrong_nonce"
  | "no_user_id";

export class OidcError extends Error {
  constructor(readonly reason: OidcFailure, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "OidcError";
  }
}

// ── Обмін коду на токени ──────────────────────────────────────────────────

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** client_secret_basic, як у документації Telegram: base64(client_id:client_secret). */
export function basicAuth(client: OidcClient): string {
  return `Basic ${b64FromBytes(encoder.encode(`${client.clientId}:${client.clientSecret}`))}`;
}

/** Код із повернення → ID-токен (рядок JWT). Код одноразовий, повтору немає. */
export async function exchangeCode(
  client: OidcClient,
  input: { code: string; verifier: string; redirectUri: string },
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: basicAuth(client),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: client.clientId,
        code_verifier: input.verifier,
      }).toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (err) {
    throw new OidcError("token_exchange", err instanceof Error ? err.message : "network");
  }
  let body: { id_token?: unknown; error?: unknown } | null = null;
  try {
    body = (await res.json()) as { id_token?: unknown; error?: unknown };
  } catch {
    body = null;
  }
  if (!res.ok || typeof body?.id_token !== "string") {
    // У журнал лише статус і код помилки OAuth, без тіла: у ньому можуть бути токени.
    const code = typeof body?.error === "string" ? body.error.slice(0, 64) : "";
    throw new OidcError("token_exchange", `http ${res.status} ${code}`.trim());
  }
  return body.id_token;
}

// ── Ключі JWKS (кеш на ізолят) ────────────────────────────────────────────

const JWKS_TTL_MS = 60 * 60 * 1000;
/** Незнайомий kid оновлює ключі не частіше разу на хвилину: сміттєві токени не мають ганяти JWKS. */
const JWKS_MIN_REFRESH_MS = 60 * 1000;

let jwksCache: { keys: Map<string, CryptoKey>; fetchedAt: number } | null = null;

/** Для тестів: забути ключі, як новий ізолят. */
export function resetJwksCache(): void {
  jwksCache = null;
}

type Jwk = { kty?: unknown; kid?: unknown; alg?: unknown; use?: unknown; n?: unknown; e?: unknown };

async function fetchJwks(fetchImpl: FetchLike): Promise<Map<string, CryptoKey>> {
  let res: Response;
  try {
    res = await fetchImpl(JWKS_URI, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) });
  } catch (err) {
    throw new OidcError("jwks_unavailable", err instanceof Error ? err.message : "network");
  }
  if (!res.ok) throw new OidcError("jwks_unavailable", `http ${res.status}`);
  const body = (await res.json().catch(() => null)) as { keys?: unknown } | null;
  if (!body || !Array.isArray(body.keys)) throw new OidcError("jwks_unavailable", "no keys");
  const keys = new Map<string, CryptoKey>();
  for (const k of body.keys as Jwk[]) {
    // Лише RSA для RS256. ES256, EdDSA й ES256K Telegram теж публікує, але ми їх не приймаємо.
    if (k.kty !== "RSA" || typeof k.kid !== "string" || typeof k.n !== "string" || typeof k.e !== "string") continue;
    if (k.alg !== undefined && k.alg !== "RS256") continue;
    if (k.use !== undefined && k.use !== "sig") continue;
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: k.n, e: k.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      keys.set(k.kid, key);
    } catch {
      // Битий ключ пропускаємо: решта набору лишається придатною.
    }
  }
  return keys;
}

/** Ключ за kid: з кешу ізоляту, а для незнайомого kid (ротація) з нового JWKS. */
export async function signingKey(kid: string, fetchImpl: FetchLike = fetch, nowMs = Date.now()): Promise<CryptoKey> {
  const cached = jwksCache;
  if (cached && nowMs - cached.fetchedAt < JWKS_TTL_MS) {
    const key = cached.keys.get(kid);
    if (key) return key;
    if (nowMs - cached.fetchedAt < JWKS_MIN_REFRESH_MS) throw new OidcError("unknown_key", kid.slice(0, 40));
  }
  let keys: Map<string, CryptoKey>;
  try {
    keys = await fetchJwks(fetchImpl);
  } catch (err) {
    // Telegram недоступний, а ключ ми вже знаємо: краще старий ключ, ніж зламаний вхід.
    const stale = cached?.keys.get(kid);
    if (stale) return stale;
    throw err;
  }
  jwksCache = { keys, fetchedAt: nowMs };
  const key = keys.get(kid);
  if (!key) throw new OidcError("unknown_key", kid.slice(0, 40));
  return key;
}

// ── Перевірка ID-токена ───────────────────────────────────────────────────

export type TelegramIdentity = {
  /** Id людини в Telegram (claim `id`), рядком: так лежить у users.telegram_id. */
  telegramId: string;
  /** Нік без @ або null. */
  username: string | null;
  /** Ім'я для показу або null. */
  name: string | null;
};

type Claims = Record<string, unknown>;

function parseJson(part: string): Claims | null {
  const bytes = bytesFromB64url(part);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Claims) : null;
  } catch {
    return null;
  }
}

function audienceMatches(aud: unknown, clientId: string): boolean {
  const list = Array.isArray(aud) ? aud : [aud];
  return list.some((a) => (typeof a === "string" || typeof a === "number") && String(a) === clientId);
}

function telegramIdFrom(claims: Claims): string | null {
  const id = claims.id;
  if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return String(id);
  if (typeof id === "string" && /^[1-9]\d{0,19}$/.test(id)) return id;
  return null;
}

const USERNAME_SHAPE = /^[A-Za-z0-9_]{3,32}$/;

function usernameFrom(claims: Claims): string | null {
  const raw = claims.preferred_username;
  if (typeof raw !== "string") return null;
  const name = raw.trim().replace(/^@/, "");
  return USERNAME_SHAPE.test(name) ? name : null;
}

function nameFrom(claims: Claims): string | null {
  const pieces =
    typeof claims.name === "string"
      ? [claims.name]
      : [claims.given_name, claims.family_name].filter((p): p is string => typeof p === "string");
  const name = pieces.join(" ").replace(/\s+/g, " ").trim().slice(0, 128);
  return name || null;
}

export type VerifyOptions = {
  clientId: string;
  /** nonce з куки цього входу. */
  nonce: string;
  nowSeconds: number;
  /** Джерело ключа за kid; за замовчуванням JWKS Telegram з кешем. */
  keyFor?: (kid: string) => Promise<CryptoKey>;
};

/**
 * Перевіряє ID-токен і віддає, хто це в Telegram. Будь-яка вада дає OidcError.
 *
 * nonce: якщо claim є, він мусить збігтися з куки. Якщо його немає, токен
 * приймаємо з попередженням у журнал: Telegram не називає nonce серед
 * claims_supported, а токен тут приходить не з браузера, а прямим запитом
 * сервера з секретом клієнта й PKCE, тож підкласти чужий токен у цей шлях нема
 * як. Перший справжній вхід покаже в журналі, чи nonce є.
 */
export async function verifyIdToken(token: string, opts: VerifyOptions): Promise<TelegramIdentity> {
  const parts = token.split(".");
  if (parts.length !== 3 || token.length > 16_384) throw new OidcError("malformed_token");
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = parseJson(headerPart);
  const claims = parseJson(payloadPart);
  if (!header || !claims) throw new OidcError("malformed_token");

  // Лише RS256. "none" і HS256 з публічним ключем як секретом не пройдуть.
  if (header.alg !== "RS256") throw new OidcError("unsupported_alg", String(header.alg).slice(0, 16));
  if (typeof header.kid !== "string" || !header.kid) throw new OidcError("malformed_token", "no kid");
  const signature = bytesFromB64url(signaturePart);
  if (!signature || signature.length === 0) throw new OidcError("malformed_token", "no signature");

  const key = await (opts.keyFor ?? ((kid: string) => signingKey(kid)))(header.kid);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    encoder.encode(`${headerPart}.${payloadPart}`),
  );
  if (!valid) throw new OidcError("bad_signature");

  if (claims.iss !== TELEGRAM_ISSUER) throw new OidcError("wrong_issuer");
  if (!audienceMatches(claims.aud, opts.clientId)) throw new OidcError("wrong_audience");

  const now = opts.nowSeconds;
  if (typeof claims.exp !== "number" || now > claims.exp + CLOCK_SKEW_SECONDS) throw new OidcError("expired");
  if (typeof claims.iat !== "number") throw new OidcError("malformed_token", "no iat");
  if (claims.iat > now + CLOCK_SKEW_SECONDS) throw new OidcError("issued_in_future");
  if (now - claims.iat > MAX_TOKEN_AGE_SECONDS) throw new OidcError("too_old");

  if (claims.nonce === undefined) {
    // Приймаємо (див. вище), але хочемо бачити в журналі, чи Telegram справді його не кладе.
    console.warn("telegram oidc: id token has no nonce claim");
  } else if (typeof claims.nonce !== "string" || !safeEqual(claims.nonce, opts.nonce)) {
    throw new OidcError("wrong_nonce");
  }

  const telegramId = telegramIdFrom(claims);
  if (!telegramId) throw new OidcError("no_user_id");
  return { telegramId, username: usernameFrom(claims), name: nameFrom(claims) };
}
