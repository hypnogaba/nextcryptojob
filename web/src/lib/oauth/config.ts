/**
 * Конектор для AI-помічників (Claude, ChatGPT та інші клієнти MCP): особистий MCP-сервер людини
 * за OAuth 2.1. Сервер авторизації й ресурс живуть у тому самому Worker (worker.ts,
 * @cloudflare/workers-oauth-provider), токени й гранти в KV `OAUTH_KV`.
 *
 * Цей файл без імпортів Next: його читає й worker.ts (до OpenNext), і маршрути сайту.
 */

export const OAUTH_ISSUER = "https://nextcryptojob.xyz";
/** Особистий MCP людини. Компанії й далі ходять на /mcp з ключем API (lib/api/mcp.ts). */
export const CONNECTOR_PATH = "/mcp/me";
export const CONNECTOR_RESOURCE = `${OAUTH_ISSUER}${CONNECTOR_PATH}`;

export const AUTHORIZE_PATH = "/oauth/authorize";
export const TOKEN_PATH = "/oauth/token";
export const REGISTER_PATH = "/oauth/register";

/**
 * Одна область на все: читати свої добірки й пошук, змінювати свій бриф і ставити 👍/👎.
 * Окремі області для запису Claude просив би одразу всі (він бере перелік ресурсу), тож
 * поділ нічого не дав би, а сторінка згоди називає обидва права словами.
 */
export const SCOPE = "jobs";

/** Що бачить людина на сторінці згоди: права словами, не назвою області. */
export const SCOPE_WORDS = [
  "Read your job brief, your daily matches and search live crypto jobs",
  "Change your brief (the job you want, remote or city, minimum salary) and rate jobs 👍/👎",
];

/** Токен доступу живе годину, оновлення 30 днів без використання. */
export const ACCESS_TOKEN_TTL_S = 60 * 60;
export const REFRESH_TOKEN_IDLE_TTL_S = 30 * 24 * 60 * 60;

/**
 * Міст від OAuth до маршруту сайту: worker.ts перевірив токен і передає людину заголовками
 * разом із секретом, який знає лише Worker. Маршрут /mcp/me без секрету відповідає 401, тож
 * підробити людину заголовком ззовні не вийде (див. lib/oauth/bridge.ts).
 */
export const BRIDGE_USER_HEADER = "x-ncj-connector-user";
export const BRIDGE_SCOPE_HEADER = "x-ncj-connector-scope";
export const BRIDGE_CLIENT_HEADER = "x-ncj-connector-client";
export const BRIDGE_KEY_HEADER = "x-ncj-connector-key";
export const BRIDGE_HEADERS = [BRIDGE_USER_HEADER, BRIDGE_SCOPE_HEADER, BRIDGE_CLIENT_HEADER, BRIDGE_KEY_HEADER];

/**
 * Куди повернути людину після входу через Telegram: запит /oauth/authorize?… у короткій куці.
 * Вхід поштою несе його в ?next=, а Telegram ходить через свій сервер і ?next= не повертає.
 */
export const RETURN_COOKIE = "ncj_oauth_return";
export const RETURN_MAX_AGE_S = 30 * 60;

/** Лише власний запит авторизації може бути адресою повернення: інакше це відкрите перенаправлення. */
export function safeReturn(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (value.length > 2048 || !value.startsWith(`${AUTHORIZE_PATH}?`) || /[\\\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const base = "https://site.invalid";
    const u = new URL(value, base);
    if (u.origin !== base || u.pathname !== AUTHORIZE_PATH) return null;
    return u.pathname + u.search;
  } catch {
    return null;
  }
}

/** Що OAuth зберігає в гранті й віддає маршруту: лише id людини. */
export type ConnectorProps = { userId: string };
