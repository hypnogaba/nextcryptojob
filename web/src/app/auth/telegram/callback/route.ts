import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { errorPath, finishTelegramLogin } from "@/lib/auth/telegram-login";
import { RETURN_COOKIE, safeReturn } from "@/lib/oauth/config";

/**
 * Повернення від Telegram (redirect URI у BotFather: <сайт>/auth/telegram/callback).
 * Уся перевірка в finishTelegramLogin; тут лише перенаправлення на результат.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  let path: string;
  try {
    path = await finishTelegramLogin(url.searchParams, url.origin);
  } catch (err) {
    console.error("telegram callback failed:", err instanceof Error ? err.message : String(err));
    path = errorPath("failed");
  }
  // Людина входила, щоб під'єднати помічника (lib/oauth/authorize.ts): повертаємо на сторінку згоди.
  const jar = await cookies();
  const back = safeReturn(jar.get(RETURN_COOKIE)?.value);
  if (back && !path.startsWith("/auth/telegram/error")) path = back;
  const response = NextResponse.redirect(new URL(path, url.origin), 303);
  if (jar.get(RETURN_COOKIE)) response.cookies.delete(RETURN_COOKIE);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
