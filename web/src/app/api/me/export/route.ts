import { exportUserData } from "@/lib/account/export";
import { currentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";

const NO_STORE = { "Cache-Control": "private, no-store" };

/** «Download my data»: файл JSON лише про людину з сесії (src/lib/account/export.ts). */
export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401, headers: NO_STORE });
  const data = await exportUserData(db(), user.id);
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
