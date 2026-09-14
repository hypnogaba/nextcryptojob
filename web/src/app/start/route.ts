import { NextResponse, type NextRequest } from "next/server";
import { currentUser } from "@/lib/auth/session";
import { BRIEF_COOKIE, cleanBrief } from "@/lib/onboarding/brief-cookie";

/**
 * Форма «What work are you looking for?» на головній: GET /start?brief=…
 * Кладе текст у куку на годину і веде до анкети: хто ввійшов, одразу на /welcome,
 * решта спершу на вхід (після входу /welcome). Порожній бриф просто веде далі.
 */
export async function GET(req: NextRequest) {
  const brief = cleanBrief(req.nextUrl.searchParams.get("brief"));
  const signedIn = (await currentUser()) !== null;
  const res = NextResponse.redirect(new URL(signedIn ? "/welcome" : "/login", req.nextUrl), 303);
  if (brief) {
    res.cookies.set(BRIEF_COOKIE, encodeURIComponent(brief), {
      path: "/",
      maxAge: 3600,
      httpOnly: true,
      sameSite: "lax",
      secure: req.nextUrl.protocol === "https:",
    });
  }
  return res;
}
