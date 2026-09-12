import { NextResponse } from "next/server";
import { errorPath, finishTelegramLogin } from "@/lib/auth/telegram-login";

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
  const response = NextResponse.redirect(new URL(path, url.origin), 303);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
