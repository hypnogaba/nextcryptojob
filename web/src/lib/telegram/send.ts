/**
 * Один виклик Bot API на всіх (перенесено з NextRole, web/src/lib/telegram-send.ts).
 *
 * Невдала відповідь іде в console.warn з описом від Telegram, щоб з журналу
 * було видно, чому людина нічого не отримала. На 429 чекаємо, скільки просить
 * retry_after, і пробуємо ще раз, один. Довше 5 с не чекаємо: вебхук мусить
 * відповісти Telegram швидко. Токен у журнал не потрапляє ніколи.
 */

export type TgResult<T = unknown> = { ok: boolean; result?: T; description?: string; error_code?: number };

type TgBody<T> = TgResult<T> & { parameters?: { retry_after?: number } };

/** Стеля очікування на 429. */
export const MAX_RETRY_MS = 5_000;
const CALL_TIMEOUT_MS = 8_000;

/** Скільки чекати перед повтором, або null, якщо повторювати не варто. */
export function retryDelayMs(status: number, body: { parameters?: { retry_after?: number } } | null): number | null {
  if (status !== 429) return null;
  const s = body?.parameters?.retry_after;
  const ms = typeof s === "number" && s > 0 ? s * 1000 : 1000;
  return ms <= MAX_RETRY_MS ? ms : null;
}

export type SendDeps = {
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function callTelegram<T = unknown>(
  token: string | undefined,
  method: string,
  payload: Record<string, unknown>,
  deps: SendDeps = {},
): Promise<TgResult<T>> {
  if (!token) return { ok: false, description: "no token" };
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;

  const once = async (): Promise<{ status: number; body: TgBody<T> }> => {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    let body: TgBody<T> = { ok: false, description: `http ${res.status}` };
    try {
      body = (await res.json()) as TgBody<T>;
    } catch {
      // Тіло не JSON: лишаємо статус.
    }
    return { status: res.status, body };
  };

  try {
    let { status, body } = await once();
    const wait = retryDelayMs(status, body);
    if (wait !== null) {
      await sleep(wait);
      ({ status, body } = await once());
    }
    if (!body.ok) {
      console.warn(`telegram ${method} failed: ${status} ${body.description ?? ""} chat=${String(payload.chat_id ?? "")}`);
    }
    return body;
  } catch (err) {
    // Повідомлення fetch може містити адресу з токеном: пишемо лише тип помилки.
    console.warn(`telegram ${method} threw: ${err instanceof Error ? err.name : "unknown"}`);
    return { ok: false, description: "network" };
  }
}

/** Екранування для parse_mode HTML: лише &, < і > (і лапки в атрибутах). */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Повідомлення з розміткою HTML, без прев'ю посилань. Текст уже екранований викликачем. */
export function sendMessage(
  token: string | undefined,
  chatId: number | string,
  html: string,
  extra: Record<string, unknown> = {},
  deps: SendDeps = {},
): Promise<TgResult> {
  return callTelegram(
    token,
    "sendMessage",
    { chat_id: chatId, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra },
    deps,
  );
}

/** Відповідь на натискання кнопки: без неї Telegram крутить годинник на кнопці. */
export function answerCallbackQuery(
  token: string | undefined,
  callbackQueryId: string,
  text?: string,
  deps: SendDeps = {},
): Promise<TgResult> {
  return callTelegram(token, "answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) }, deps);
}
