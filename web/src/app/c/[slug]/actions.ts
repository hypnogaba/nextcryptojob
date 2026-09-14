"use server";

import { headers } from "next/headers";
import type { FormMessage } from "@/components/form/form-message";
import { audit } from "@/lib/audit";
import { clientIp, consume, type Limits } from "@/lib/auth/ratelimit";
import { isReportReason } from "@/lib/card/report";
import { getCard } from "@/lib/card/store";
import { db } from "@/lib/db";

// «Report this card»: частина моделі довіри 13.09 (docs/DECISIONS.md). Джерела на картці людина
// вписала сама, тож будь-хто може сказати, що картка чужа чи підроблена. Скарга йде в audit_log
// (action 'card.report', target = slug), без тексту й без того, хто скаржиться: адмін бачить,
// на які картки скаржаться, і відкликає їх вручну.

export type ReportState = { message?: FormMessage };

/** 5 скарг на годину з однієї адреси: досить людині, мало для засмічення журналу. */
const REPORT_LIMITS: Limits = { windowMinutes: 60, maxAttempts: 5, blockMinutes: 60 };

export async function reportCardAction(_prev: ReportState, form: FormData): Promise<ReportState> {
  const slug = String(form.get("slug") ?? "");
  const reason = String(form.get("reason") ?? "");
  if (!isReportReason(reason)) return { message: { tone: "error", text: "Pick a reason." } };
  const d = db();
  if (!(await getCard(d, slug))) return { message: { tone: "error", text: "This card no longer exists." } };
  const verdict = await consume(`card-report:${clientIp(await headers())}`, REPORT_LIMITS, d);
  if (!verdict.allowed) return { message: { tone: "error", text: `Too many reports. Try again in ${verdict.retryAfterMinutes} minutes.` } };
  await audit(null, "card.report", slug, { reason });
  return { message: { tone: "success", text: "Thank you. We will look at this card." } };
}
