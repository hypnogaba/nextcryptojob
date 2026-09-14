import { getSettings, siteNotice } from "@/lib/admin/settings";
import { recordVisit } from "@/lib/analytics/visits";
import { isAdminEmail, isAdminSession } from "@/lib/auth/admin";
import { currentUser } from "@/lib/auth/session";
import { appEnv, db } from "@/lib/db";

/**
 * Чи є сесія, чи це адмін (пункт «Admin» у шапці), і повідомлення на весь сайт
 * (/admin/settings). Потрібно шапці сайту: вона статична (головна, /privacy, /terms
 * віддаються без Worker-рендера), тож стан дізнається цим запитом з браузера. Без куки
 * сесію в базі не шукаємо; налаштування йдуть з кешу ізоляту (одне читання на хвилину).
 * Пошти й id не віддаємо.
 *
 * Той самий запит рахує перегляд сторінки (lib/analytics/visits.ts): шапка шле `v` = шлях
 * сторінки, `r` = document.referrer першого завантаження, `n=1` для переходу всередині
 * сайту. Переглядів адміна не рахуємо.
 */
export async function GET(request: Request) {
  const [user, settings] = await Promise.all([currentUser(), getSettings(db())]);
  const env = appEnv() as { ADMIN_EMAILS?: string; SESSION_SECRET?: string };
  const admin = user !== null && isAdminSession(user, env.ADMIN_EMAILS);

  const url = new URL(request.url);
  const path = url.searchParams.get("v");
  if (path && !(user && isAdminEmail(user.email, env.ADMIN_EMAILS))) {
    await recordVisit(db(), {
      pathname: path.slice(0, 300),
      referrer: url.searchParams.get("r"),
      internal: url.searchParams.get("n") === "1",
      ip: request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "",
      userAgent: request.headers.get("user-agent") ?? "",
      ownHost: url.host,
      secret: env.SESSION_SECRET ?? "",
    });
  }

  return Response.json(
    { signedIn: user !== null, admin, notice: siteNotice(settings) },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
