import { appEnv, db } from "@/lib/db";
import { badLinkPage, simplePage } from "@/lib/digest/simple-page";
import { unsubscribeKey } from "@/lib/digest/unsubscribe";
import { answerStillLooking, verifyStillLooking } from "@/lib/nudges/still-looking";

/**
 * «Yes» на «Still looking?» з листа (lib/nudges/still-looking.ts). Підписане посилання: u (людина), t (HMAC).
 * GET: сторінка з кнопкою, нічого не міняє (сканери посилань у поштових скриньках відкривають адреси без людини).
 * POST: добірка йде далі; якщо її вже поставили на паузу через тишу, пауза знімається.
 */

async function verified(request: Request): Promise<string | null> {
  const key = unsubscribeKey(appEnv());
  return key ? verifyStillLooking(key, new URL(request.url).searchParams) : null;
}

export async function GET(request: Request): Promise<Response> {
  if (!(await verified(request))) return badLinkPage();
  return simplePage(
    200,
    "Still looking for a crypto job?",
    `<p>Tap yes and your daily jobs keep coming.</p><form method="post"><button type="submit">Yes, keep them coming</button></form>`,
  );
}

export async function POST(request: Request): Promise<Response> {
  const userId = await verified(request);
  if (!userId) return badLinkPage();
  const answered = await answerStillLooking(db(), userId);
  return answered
    ? simplePage(200, "Great. Your daily jobs keep coming.", `<p>Change the hour or the channel in <a href="/settings">settings</a>.</p>`)
    : simplePage(200, "Nothing to confirm.", `<p>Your daily jobs settings are in <a href="/settings">settings</a>.</p>`);
}
