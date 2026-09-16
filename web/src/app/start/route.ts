import { NextResponse, type NextRequest } from "next/server";
import { recordFunnelEvent } from "@/lib/analytics/funnel";
import { currentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { isJobRef } from "@/lib/jobs/saved";
import { WANTED_JOB_COOKIE, WANTED_JOB_MAX_AGE } from "@/lib/jobs/wanted";
import { BRIEF_COOKIE, cleanBrief } from "@/lib/onboarding/brief-cookie";

/**
 * Форма «What work are you looking for?» на головній: GET /start?brief=…
 * Кладе текст у куку на годину і веде до анкети: хто ввійшов, одразу на /welcome,
 * решта спершу на вхід (після входу /welcome). Порожній бриф просто веде далі.
 *
 * Це перший крок брифу для воронки продукту (/admin/funnel, D): +1 до funnel_days
 * ('brief_started'), незалежно від того, чи людина ввійшла.
 *
 * Раунд 6: сюди ж веде рядок живої стрічки на головній, GET /start?job=<ref>. Вакансію кладемо
 * в куку на тиждень; хто ввійшов, іде одразу на її сторінку, решта на вхід, а сама вакансія
 * лягає в збережені, щойно з'явиться сесія (lib/auth/session.ts createSession).
 */
export async function GET(req: NextRequest) {
  const brief = cleanBrief(req.nextUrl.searchParams.get("brief"));
  const wantedJob = req.nextUrl.searchParams.get("job");
  const job = isJobRef(wantedJob) ? wantedJob : null;
  const signedIn = (await currentUser()) !== null;
  await recordFunnelEvent(db(), "brief_started");
  const next = signedIn ? (job ? `/jobs/${encodeURIComponent(job)}` : "/welcome") : "/login";
  const res = NextResponse.redirect(new URL(next, req.nextUrl), 303);
  if (job) {
    res.cookies.set(WANTED_JOB_COOKIE, job, {
      path: "/",
      maxAge: WANTED_JOB_MAX_AGE,
      httpOnly: true,
      sameSite: "lax",
      secure: req.nextUrl.protocol === "https:",
    });
  }
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
