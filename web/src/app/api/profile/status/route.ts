import { currentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { profileStatus } from "@/lib/score/status";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * Стан балу для сторінки профілю, яка питає його кожні 5 с, поки завдання
 * чекає. Лише про людину з сесії: стан завдання й чи є бал, без ніків,
 * адрес і чисел балу.
 */
export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401, headers: NO_STORE });
  return Response.json(await profileStatus(db(), user.id), { headers: NO_STORE });
}
