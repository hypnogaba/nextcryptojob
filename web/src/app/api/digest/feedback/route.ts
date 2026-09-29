import { appEnv, db } from "@/lib/db";
import { FEEDBACK_REASONS, isReason, recordFeedback, verifyFeedback } from "@/lib/digest/feedback";
import { badLinkPage, simplePage } from "@/lib/digest/simple-page";
import { unsubscribeKey } from "@/lib/digest/unsubscribe";
import { jobsDb } from "@/lib/jobs-db";
import { escapeHtml } from "@/lib/mail/digest";

/**
 * «Not for me» з листа добірки (lib/digest/feedback.ts). Підписане посилання: u (людина), j (вакансія), t (HMAC).
 * GET: сторінка з причинами і кнопкою, нічого не міняє (сканери посилань відкривають адреси без людини).
 * POST: 👎 за вакансію; компанія на 30 днів зникає з добірки цієї людини.
 */

async function verified(request: Request) {
  const key = unsubscribeKey(appEnv());
  return key ? verifyFeedback(key, new URL(request.url).searchParams) : null;
}

export async function GET(request: Request): Promise<Response> {
  if (!(await verified(request))) return badLinkPage();
  const reasons = Object.entries(FEEDBACK_REASONS)
    .map(
      ([value, label]) =>
        `<label><input type="radio" name="reason" value="${escapeHtml(value)}"> ${escapeHtml(label)}</label>`,
    )
    .join("");
  return simplePage(
    200,
    "Not for me?",
    `<p>Tell us why, if you like. We stop showing jobs from this company for 30 days.</p>` +
      `<form method="post" style="display:grid;gap:8px">${reasons}<button type="submit">Not for me</button></form>`,
  );
}

export async function POST(request: Request): Promise<Response> {
  const who = await verified(request);
  if (!who) return badLinkPage();
  let reason = null;
  try {
    const value = (await request.formData()).get("reason");
    if (isReason(value)) reason = value;
  } catch {
    // Тіло без форми: голос без причини.
  }
  const res = await recordFeedback(db(), jobsDb(), who.userId, who.ref, "down", reason);
  if (res !== "saved") return simplePage(404, "We could not find this job.", `<p>See your jobs in <a href="/jobs">your jobs</a>.</p>`);
  return simplePage(
    200,
    "Thanks, noted.",
    `<p>We will not show jobs from this company for 30 days. Change what you look for in <a href="/settings">settings</a>.</p>`,
  );
}
