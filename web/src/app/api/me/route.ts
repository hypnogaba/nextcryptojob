import { getSettings, siteNotice } from "@/lib/admin/settings";
import { currentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";

/**
 * Чи є сесія, і повідомлення на весь сайт (/admin/settings). Потрібно шапці
 * сайту: вона статична (головна, /privacy, /terms віддаються без Worker-рендера),
 * тож стан дізнається цим запитом з браузера. Без куки сесію в базі не шукаємо;
 * налаштування йдуть з кешу ізоляту (одне читання на хвилину). Пошти й id не віддаємо.
 */
export async function GET() {
  const [user, settings] = await Promise.all([currentUser(), getSettings(db())]);
  return Response.json(
    { signedIn: user !== null, notice: siteNotice(settings) },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
