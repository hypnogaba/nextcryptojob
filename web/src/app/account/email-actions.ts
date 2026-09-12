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
import { clientIp } from "@/lib/auth/ratelimit";
import { requireUser } from "@/lib/auth/session";

/**
 * «Add email» для людини без пошти (вхід лише через Telegram), на /account і
 * /settings. Той самий код з листа, що й для входу, але прив'язаний до цієї
 * людини (lib/auth/email-code.ts, CodePurpose). users.email з'являється лише
 * після правильного коду.
 */

export type AddEmailState = { step: "email" | "code" | "done"; email: string; message?: FormMessage };

const GENERIC: FormMessage = { tone: "error", text: "Something went wrong. Try again." };
const UNAVAILABLE = "Adding an email opens soon.";
const HAS_EMAIL: FormMessage = { tone: "error", text: "Your profile already has an email." };
const TAKEN: FormMessage = { tone: "error", text: "This email is linked to another profile." };

function added(): FormMessage {
  return { tone: "success", text: "Email added. You can now get daily jobs there and sign in with it." };
}

export async function addEmailAction(prev: AddEmailState, form: FormData): Promise<AddEmailState> {
  const user = await requireUser();
  const intent = form.get("intent");
  const email = String(form.get("email") ?? "").trim();

  if (user.email) return { step: "email", email, message: HAS_EMAIL };
  if (intent === "change") return { step: "email", email };

  if (intent === "verify") {
    let res: AddEmailResult;
    try {
      res = await verifyAddEmailCode(user.id, email, form.get("code"));
    } catch (err) {
      console.error("verifyAddEmailCode failed:", err instanceof Error ? err.message : String(err));
      return { step: "code", email, message: GENERIC };
    }
    if (res.ok) {
      revalidatePath("/account");
      revalidatePath("/settings");
      return { step: "done", email: res.email, message: added() };
    }
    switch (res.reason) {
      case "no_user":
        redirect("/login");
      case "taken":
        return { step: "email", email, message: TAKEN };
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
