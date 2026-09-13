import { applyUrlOf } from "@/lib/crm/jobs";
import { liveApplyUrl, recordApplyClick } from "@/lib/crm/public-jobs";
import { db } from "@/lib/db";
import { isId } from "@/lib/ids";

/**
 * "Apply" з публічної сторінки вакансії (специфікація CRM 5.6): +1 до apply_clicks і
 * перехід на apply_url компанії (https:// або mailto:). Вакансія не жива: назад на
 * /jobs/<id>, де написано "This job is closed.", і лічильник не рухається.
 *
 * Передвантаження браузера (Sec-Purpose: prefetch) і HEAD переходом не рахуються.
 * Відповідь не кешується й не індексується.
 */

type Ctx = { params: Promise<{ id: string }> };

const NO_STORE = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

function isPrefetch(request: Request): boolean {
  const purpose = `${request.headers.get("sec-purpose") ?? ""} ${request.headers.get("purpose") ?? ""}`;
  return /prefetch|prerender/i.test(purpose);
}

function to(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location, ...NO_STORE } });
}

async function serve(request: Request, { params }: Ctx, count: boolean): Promise<Response> {
  const { id } = await params;
  const page = `/jobs/${encodeURIComponent(id)}`;
  if (!isId("job", id)) return to(page);
  const raw = count && !isPrefetch(request) ? await recordApplyClick(db(), id) : await liveApplyUrl(db(), id);
  // Адресу перевірено при збереженні; ще раз, бо рядок міг потрапити в базу повз реєстр.
  const url = raw ? applyUrlOf(raw) : null;
  return to(url ?? page);
}

export function GET(request: Request, ctx: Ctx): Promise<Response> {
  return serve(request, ctx, true);
}

export function HEAD(request: Request, ctx: Ctx): Promise<Response> {
  return serve(request, ctx, false);
}
