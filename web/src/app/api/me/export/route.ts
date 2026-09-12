import { exportUserData } from "@/lib/account/export";
import { consume, EXPORT_LIMITS } from "@/lib/auth/ratelimit";
import { currentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * «Download my data»: файл JSON лише про людину з сесії (src/lib/account/export.ts).
 * Не частіше 10 разів на годину (`export:<user id>`): файл читає багато таблиць.
 * Лічильник закінчується на `:<user id>`, тож видалення акаунта його прибирає.
 */
export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401, headers: NO_STORE });
  const d = db();
  const rate = await consume(`export:${user.id}`, EXPORT_LIMITS, d);
  if (!rate.allowed) {
    const minutes = rate.retryAfterMinutes;
    return Response.json(
      { error: `Too many downloads. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(minutes * 60) } },
    );
  }
  const data = await exportUserData(d, user.id);
  if (!data) return Response.json({ error: "Sign in first." }, { status: 401, headers: NO_STORE });
  const day = data.exported_at.slice(0, 10);
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      ...NO_STORE,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="nextcryptojob-data-${day}.json"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
