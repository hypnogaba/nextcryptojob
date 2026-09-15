import { recordFunnelEvent } from "@/lib/analytics/funnel";
import type { CrmEnv } from "@/lib/crm/context";
import { liveApplyUrl, recordApplyClick } from "@/lib/crm/public-jobs";
import { appEnv, db } from "@/lib/db";
import { isId } from "@/lib/ids";
import { applyVisitorKey, countableVisit } from "@/lib/jobs/apply";

/**
 * "Apply" з публічної сторінки вакансії (специфікація CRM 5.6): +1 до apply_clicks і
 * перехід на apply_url компанії (https:// або mailto:). Хто рахується, вирішує
 * lib/jobs/apply.ts (боти, передвантаження, RL_PUBLIC, раз на 10 хвилин); перехід буде в
 * будь-якому разі. Вакансія не жива: 404 "This job is closed." одразу тут.
 * Пошуковикам шлях закрито в robots.ts. Відповідь не кешується й не індексується.
 */

type Ctx = { params: Promise<{ id: string }> };

const NO_STORE = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

function to(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location, ...NO_STORE } });
}

const CLOSED_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>This job is closed | NextCryptoJob</title></head>
<body style="font-family: system-ui, sans-serif; margin: 0; padding: 40px 16px; line-height: 1.5">
<main style="max-width: 48rem; margin: 0 auto">
<h1>This job is closed.</h1>
<p>The company closed it, filled it or it expired. It no longer takes applications.</p>
<p><a href="/">Get crypto jobs that match your track record</a></p>
</main></body></html>`;

/** 404 "This job is closed." (той самий текст, що not-found.tsx сторінки вакансії). */
function closed(): Response {
  return new Response(CLOSED_HTML, { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE } });
}

export async function GET(request: Request, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  if (!isId("job", id)) return closed();
  const env = appEnv() as unknown as CrmEnv;
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const visitor = (await countableVisit(request, env, ip)) ? await applyVisitorKey(env, ip, id) : null;
  const click = await recordApplyClick(db(), id, visitor);
  if (click?.counted) await recordFunnelEvent(db(), "apply_click");
  return click ? to(click.url) : closed();
}

/** HEAD нічого не рахує. */
export async function HEAD(_request: Request, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  const url = isId("job", id) ? await liveApplyUrl(db(), id) : null;
  return url ? to(url) : closed();
}
