"use server";

import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth/session";
import { firstCardName, issueCard } from "@/lib/card/issue";
import { getIdentity } from "@/lib/identity/store";
import { db } from "@/lib/db";
import { enqueueScoreJob } from "@/lib/score/queue";

// Дії сторінки /welcome/score. Обидві викликає браузер сам, без натискання: сторінка GET нічого
// не пише, а черга й картка з'являються лише POST-запитом цієї людини.

export type EnsureResult = { state: "queued" } | { state: "wait"; seconds: number } | { state: "no_consent" };

/**
 * Ставить бал у чергу, якщо його ще немає або джерела змінились після останнього. Правило 60 с і
 * «не дублювати» стежить сама черга; «зарано» повертає, скільки секунд чекати до наступної спроби.
 */
export async function ensureScoreAction(): Promise<EnsureResult> {
  const user = await requireUser();
  const d = db();
  // Людина щойно пройшла анкету й стоїть перед балом: якщо бала ще немає, ставимо завдання
  // навіть у межах 60 секунд від попереднього (те, на вході, рахувало ще без джерел).
  const scored = await d.prepare("SELECT 1 AS yes FROM scores WHERE user_id = ? LIMIT 1").bind(user.id).first<{ yes: number }>();
  const res = await enqueueScoreJob(d, user.id, "connect", { force: !scored });
  if (res.ok || res.reason === "already_queued") return { state: "queued" };
  if (res.reason === "too_soon") return { state: "wait", seconds: res.retryAfterSeconds };
  return { state: "no_consent" };
}

export type IssueFirstResult = { ok: true; slug: string } | { ok: false; message: string };

/**
 * Перша картка одразу після балу: роль з найвищим балом, ім'я з X. Активна картка з тим самим
 * балом лишається (повторне відкриття сторінки нічого не відкликає).
 */
export async function issueFirstCardAction(role: string): Promise<IssueFirstResult> {
  const user = await requireUser();
  const d = db();
  const x = await getIdentity(d, user.id, "x");
  let res;
  try {
    res = await issueCard(d, user.id, { role, displayName: firstCardName(x?.value ?? null, user.email), reuse: true });
  } catch (err) {
    console.error("first card failed:", err instanceof Error ? err.message : String(err));
    return { ok: false, message: "Something went wrong. Try again." };
  }
  if (!res.ok) return res;
  if (!res.reused) await audit(user.id, "card.create", res.slug, { role, first: true });
  return { ok: true, slug: res.slug };
}
