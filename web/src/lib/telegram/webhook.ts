import { safeEqual } from "@/lib/auth/hash";
import { clientIp, consume, type Limits } from "@/lib/auth/ratelimit";
import { db } from "@/lib/db";
import { handleUpdate, type TgUpdate } from "./bot";
import type { TelegramEnv } from "./env";
import type { SendDeps } from "./send";

/**
 * Вебхук Telegram (за мотивами NextRole, web/src/app/api/telegram/webhook/route.ts).
 *
 * - Закритий за замовчуванням: без TELEGRAM_WEBHOOK_SECRET або без точного
 *   заголовка x-telegram-bot-api-secret-token відповідь 401 і жодного запиту
 *   до бази. Секрет знає лише Telegram (задається в setWebhook), тож сторонній,
 *   що знайшов адресу, не підробить оновлення від чужого chat_id. Підбирати
 *   32 випадкові байти марно, тож лічильника невдач тут немає: він коштував
 *   би запис у D1 на кожен сміттєвий запит.
 * - Кожен update_id обробляється один раз (webhook_updates): Telegram повторює
 *   оновлення, на яке не почув 200.
 * - Після перевірки секрету відповідь завжди 200: виняток усередині інакше
 *   означав би той самий апдейт по колу.
 */

/** Оновлення з одного чату: 20 за хвилину, далі 5 хвилин тиші. */
export const BOT_CHAT_LIMITS: Limits = { windowMinutes: 1, maxAttempts: 20, blockMinutes: 5 };
const MAX_BODY_BYTES = 256 * 1024;

const ok = () => Response.json({ ok: true });

function isUpdate(value: unknown): value is TgUpdate {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { update_id?: unknown }).update_id === "number" &&
    Number.isSafeInteger((value as { update_id: number }).update_id)
  );
}

/** true, якщо цей update_id бачимо вперше. Зрідка прибирає записи, старші за 3 дні. */
export async function claimUpdate(d: D1Database, updateId: number): Promise<boolean> {
  const res = await d
    .prepare("INSERT INTO webhook_updates (update_id) VALUES (?) ON CONFLICT(update_id) DO NOTHING")
    .bind(updateId)
    .run();
  if (res.meta.changes !== 1) return false;
  if (updateId % 100 === 0) {
    await d.prepare("DELETE FROM webhook_updates WHERE seen_at < datetime('now', '-3 days')").run();
  }
  return true;
}

function chatOf(update: TgUpdate): number | null {
  return update.message?.chat?.id ?? update.callback_query?.message?.chat?.id ?? update.callback_query?.from?.id ?? null;
}

export async function handleWebhookRequest(request: Request, env: TelegramEnv, deps: SendDeps = {}): Promise<Response> {
  const expected = env.TELEGRAM_WEBHOOK_SECRET;
  const got = request.headers.get("x-telegram-bot-api-secret-token");
  if (!expected || !got || !safeEqual(got, expected)) {
    console.warn(`telegram webhook: bad secret from ${clientIp(request.headers)}`);
    return Response.json({ ok: false }, { status: 401 });
  }

  let update: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return ok();
    update = JSON.parse(text);
  } catch {
    return ok();
  }
  if (!isUpdate(update)) return ok();

  try {
    const d = db();
    if (!(await claimUpdate(d, update.update_id))) return ok();
    const chatId = chatOf(update);
    if (chatId !== null && !(await consume(`tg-chat:${chatId}`, BOT_CHAT_LIMITS)).allowed) return ok();
    await handleUpdate(update, { token: env.TELEGRAM_BOT_TOKEN, origin: new URL(request.url).origin, deps });
  } catch (err) {
    console.error(`telegram webhook failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return ok();
}
