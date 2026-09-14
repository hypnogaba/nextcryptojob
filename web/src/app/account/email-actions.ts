"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { FormMessage } from "@/components/form/form-message";
import { requestCodeMessage, verifyCodeMessage } from "@/lib/auth/code-messages";
import {
  CODE_TTL_MINUTES,
  requestCode,
  verifyAddEmailCode,
  type AddEmailResult,
  type RequestCodeResult,
} from "@/lib/auth/email-code";
import { checkMergeGrant, mergeAccounts, mergeGrant } from "@/lib/account/merge";
import { clientIp } from "@/lib/auth/ratelimit";
import { requireUser } from "@/lib/auth/session";
import { appEnv, db } from "@/lib/db";
import { markSourcesChanged } from "@/lib/score/changes";
import { enqueueScoreJob } from "@/lib/score/queue";

/**
 * «Add email» для людини без пошти (вхід лише через Telegram), на /account,
 * /settings і в кроці анкети про канал. Той самий код з листа, що й для входу, але прив'язаний до цієї
 * людини (lib/auth/email-code.ts, CodePurpose). users.email з'являється лише
 * після правильного коду.
 *
 * Якщо пошта вже належить іншому профілю (власник 14.09, раунд 3: два профілі, Telegram і пошта),
 * правильний код доводить, що обидва профілі однієї людини: крок «merge» пропонує злити їх в
 * один (lib/account/merge.ts). Дозвіл на злиття живе в стані форми (grant, HMAC, 15 хв).
 */

export type AddEmailState = {
  step: "email" | "code" | "merge" | "done";
  email: string;
  /** Дозвіл на злиття після правильного коду (лише на кроці merge). */
  grant?: string;
  message?: FormMessage;
};

const GENERIC: FormMessage = { tone: "error", text: "Something went wrong. Try again." };
const UNAVAILABLE = "Adding an email opens soon.";
const HAS_EMAIL: FormMessage = { tone: "error", text: "Your profile already has an email." };
const TAKEN: FormMessage = { tone: "error", text: "This email is linked to another profile." };
const MERGE_OFFER: FormMessage = {
  tone: "info",
  text: "This email is already on your other NextCryptoJob account. The code shows both are yours, so you can merge them into this one.",
};
const MERGE_EXPIRED: FormMessage = { tone: "error", text: "This merge offer has expired. Send a new code to try again." };
const MERGE_CONFLICT: FormMessage = {
  tone: "error",
  text: "The two accounts have different Telegram accounts connected, so we cannot merge them here. Write to us and we will do it.",
};

function merged(): FormMessage {
  return {
    tone: "success",
    text: "Accounts merged. Everything is on this account now, and you can sign in with this email or with Telegram.",
  };
}

/** Після пошти чи злиття сторінки з поштою й каналом добірки перебудовуються. */
function refresh() {
  revalidatePath("/account");
  revalidatePath("/settings");
  // Крок анкети «How should we send your jobs?»: після пошти з'являється варіант Email.
  revalidatePath("/welcome");
}

function added(): FormMessage {
  return { tone: "success", text: "Email added. You can now get daily jobs there and sign in with it." };
}

export async function addEmailAction(prev: AddEmailState, form: FormData): Promise<AddEmailState> {
  const user = await requireUser();
  const intent = form.get("intent");
  const email = String(form.get("email") ?? "").trim();

  if (user.email) return { step: "email", email, message: HAS_EMAIL };
  if (intent === "change") return { step: "email", email };
  if (intent === "merge") return mergeStep(user.id, email, form.get("grant"));

  if (intent === "verify") {
    let res: AddEmailResult;
    try {
      res = await verifyAddEmailCode(user.id, email, form.get("code"));
    } catch (err) {
      console.error("verifyAddEmailCode failed:", err instanceof Error ? err.message : String(err));
      return { step: "code", email, message: GENERIC };
    }
    if (res.ok) {
      refresh();
      return { step: "done", email: res.email, message: added() };
    }
    switch (res.reason) {
      case "no_user":
        redirect("/login");
      case "taken": {
        const secret = appEnv().SESSION_SECRET;
        if (!res.otherId || !secret) return { step: "email", email, message: TAKEN };
        const address = email.toLowerCase();
        return { step: "merge", email: address, grant: await mergeGrant(secret, user.id, res.otherId, address), message: MERGE_OFFER };
      }
      case "has_email":
        return { step: "email", email, message: HAS_EMAIL };
      case "invalid_email":
        return { step: "email", email, message: verifyCodeMessage(res, UNAVAILABLE) };
      default:
        return { step: "code", email, message: verifyCodeMessage(res, UNAVAILABLE) };
    }
  }

  // intent === "send": перший код або новий замість старого.
  let res: RequestCodeResult;
  try {
    res = await requestCode(email, clientIp(await headers()), { kind: "add_email", userId: user.id });
  } catch (err) {
    console.error("requestCode (add email) failed:", err instanceof Error ? err.message : String(err));
    return { step: prev.step === "code" ? "code" : "email", email, message: GENERIC };
  }
  if (res.ok) {
    return {
      step: "code",
      email: res.email,
      message: {
        tone: "info",
        text: `We sent a 6-digit code to ${res.email}. It expires in ${CODE_TTL_MINUTES} minutes.`,
      },
    };
  }
  const step = prev.step === "code" && res.reason !== "invalid_email" ? "code" : "email";
  return { step, email, message: requestCodeMessage(res, UNAVAILABLE) };
}

/**
 * «Merge the two accounts»: лише з дійсним дозволом, виданим після правильного коду на цю пошту.
 * Профіль, яким людина зараз увійшла, лишається; другий зливається в нього.
 */
async function mergeStep(userId: string, rawEmail: string, grant: FormDataEntryValue | null): Promise<AddEmailState> {
  const email = rawEmail.trim().toLowerCase();
  const secret = appEnv().SESSION_SECRET;
  const d = db();
  const other = await d
    .prepare("SELECT id FROM users WHERE lower(email) = ? AND id <> ? LIMIT 1")
    .bind(email, userId)
    .first<{ id: string }>();
  if (!secret || !other || !(await checkMergeGrant(secret, grant, userId, other.id, email))) {
    return { step: "email", email, message: MERGE_EXPIRED };
  }
  let res: Awaited<ReturnType<typeof mergeAccounts>>;
  try {
    res = await mergeAccounts(d, userId, other.id);
  } catch (err) {
    console.error("mergeAccounts failed:", err instanceof Error ? err.message : String(err));
    return { step: "merge", email, grant: String(grant), message: GENERIC };
  }
  if (!res.ok) {
    if (res.reason === "conflict") return { step: "email", email, message: MERGE_CONFLICT };
    return { step: "email", email, message: GENERIC };
  }
  // Джерела обох профілів тепер в одному: бал перераховуємо (черга сама стежить за 60 с).
  await markSourcesChanged(d, userId, "sources");
  await enqueueScoreJob(d, userId, "connect");
  refresh();
  revalidatePath("/jobs");
  revalidatePath("/profile");
  return { step: "done", email, message: merged() };
}
