import { NextResponse, type NextRequest } from "next/server";
import { recordFunnelEvent } from "@/lib/analytics/funnel";
import { currentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { BRIEF_COOKIE, cleanBrief } from "@/lib/onboarding/brief-cookie";

/**
 * Форма «What work are you looking for?» на головній: GET /start?brief=…
 * Кладе текст у куку на годину і веде до анкети: хто ввійшов, одразу на /welcome,
 * решта спершу на вхід (після входу /welcome). Порожній бриф просто веде далі.
 *
 * Це перший крок брифу для воронки продукту (/admin/funnel, D): +1 до funnel_days
 * ('brief_started'), незалежно від того, чи людина ввійшла.
 */
export async function GET(req: NextRequest) {
  const brief = cleanBrief(req.nextUrl.searchParams.get("brief"));
  const signedIn = (await currentUser()) !== null;
  await recordFunnelEvent(db(), "brief_started");
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
