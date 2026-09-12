"use server";

import { headers } from "next/headers";
import { currentUser } from "@/lib/auth/session";
import { requestOrigin } from "@/lib/billing/origin";
import {
  answerText,
  authorizeCandidate,
  candidateIntroRow,
  candidateState,
  outcomeForState,
  respondToIntro,
  type IntroDecision,
} from "@/lib/crm/intros";
import { ANSWER_TEXT, notifierFromEnv, type NotifyEnv } from "@/lib/crm/notify";
import { appEnv, db } from "@/lib/db";
import { isId } from "@/lib/ids";

/**
 * Відповідь кандидата зі сторінки /intro/[id] (специфікація CRM, 5.5). Лише POST:
 * поштові сканери відкривають посилання GET-ом, і сторінка від цього нічого не
 * змінює. Токен з листа одноразовий і діє до expires_at; із сесією кандидата не
 * потрібен. Стан (відповів, прострочено, відкликано) кажемо до перевірки токена:
 * після відповіді токен у базі стерто.
 */

export type IntroAnswerState = {
  /** Відповідь остаточна: форма ховає кнопки. */
  done?: boolean;
  tone?: "success" | "error" | "info";
  text?: string;
};

const DECISIONS: readonly IntroDecision[] = ["accept", "decline", "block"];

function field(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
}

export async function answerIntroAction(_prev: IntroAnswerState, form: FormData): Promise<IntroAnswerState> {
  const introId = field(form, "intro_id");
  const decision = field(form, "decision") as IntroDecision;
  if (!isId("int", introId) || !DECISIONS.includes(decision)) {
    return { done: true, tone: "error", text: ANSWER_TEXT.invalid };
  }

  const d = db();
  const now = new Date();
  const row = await candidateIntroRow(d, introId);
  if (!row) return { done: true, tone: "error", text: ANSWER_TEXT.invalid };
  const state = candidateState(row, now);
  if (state !== "pending") return { done: true, tone: "info", text: answerText(outcomeForState(state)) };

  const user = await currentUser();
  const auth = await authorizeCandidate(row, { token: field(form, "t"), sessionUserId: user?.id ?? null });
  if (!auth) return { done: true, tone: "error", text: ANSWER_TEXT.invalid };

  const origin = requestOrigin(await headers());
  const outcome = await respondToIntro(d, {
    introId,
    userId: row.user_id,
    decision,
    via: "web",
    now,
    notifier: notifierFromEnv(appEnv() as unknown as NotifyEnv, { origin }),
  });
  const text = answerText(outcome);
  if (outcome.kind === "accepted" || outcome.kind === "declined") return { done: true, tone: "success", text };
  if (outcome.kind === "no_contact") return { tone: "error", text };
  return { done: true, tone: "info", text };
}
