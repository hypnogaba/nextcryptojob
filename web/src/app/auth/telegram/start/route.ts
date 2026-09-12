import { NextResponse } from "next/server";
import { beginTelegramLogin, errorPath } from "@/lib/auth/telegram-login";

/**
 * «Continue with Telegram» і «Connect Telegram»: ставить куку стану й веде на
 * oauth.telegram.org. GET за посиланням, а не форма: перехід за посиланням CSP
 * не обмежує, і перенаправлення після нього теж.
 */
export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  let target: string | null;
  try {
    target = await beginTelegramLogin(origin);
  } catch (err) {
    console.error("telegram start failed:", err instanceof Error ? err.message : String(err));
    target = new URL(errorPath("failed"), origin).toString();
  }
  const response = NextResponse.redirect(target ?? new URL(errorPath("unavailable"), origin), 303);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
