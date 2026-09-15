import { NextResponse, type NextRequest } from "next/server";
import { recordFunnelEvent } from "@/lib/analytics/funnel";
import { db } from "@/lib/db";

/**
 * Редірект «Share on X» (D, /admin/funnel): рахує клік у funnel_days ('share_click'),
 * потім веде на x.com/intent/post з тими самими параметрами. Куди веде, вирішує лише
 * цей код (x.com завжди, хост не береться з запиту): відкритого редіректу тут немає.
 * Параметри ті самі, що будував lib/card/share.ts (xShareUrl): `text`, `url`.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const text = req.nextUrl.searchParams.get("text") ?? "";
  const url = req.nextUrl.searchParams.get("url") ?? "";
  await recordFunnelEvent(db(), "share_click");
  const target = new URL("https://x.com/intent/post");
  if (text) target.searchParams.set("text", text);
  if (url) target.searchParams.set("url", url);
  return NextResponse.redirect(target.toString(), { status: 303, headers: { "Cache-Control": "no-store" } });
}
