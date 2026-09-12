"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requestCodeMessage, verifyCodeMessage } from "@/lib/auth/code-messages";
import {
  CODE_TTL_MINUTES,
  requestCode,
  verifyCode,
  type RequestCodeResult,
  type VerifyCodeResult,
} from "@/lib/auth/email-code";
import { clientIp } from "@/lib/auth/ratelimit";
import { signOut } from "@/lib/auth/session";

/**
 * Дії входу. Server Action, бо лише вони (і Route Handler) можуть ставити
 * куку сесії. Одна дія на форму, крок обирає кнопка (name="intent").
 */

export type LoginMessage = { tone: "error" | "info"; text: string };
export type LoginState = { step: "email" | "code"; email: string; message?: LoginMessage };

const GENERIC: LoginMessage = { tone: "error", text: "Something went wrong. Try again." };
const UNAVAILABLE = "Email sign-in opens soon.";

export async function loginAction(prev: LoginState, form: FormData): Promise<LoginState> {
  const intent = form.get("intent");
  const email = String(form.get("email") ?? "").trim();

  if (intent === "change") return { step: "email", email };

  if (intent === "verify") {
    let res: VerifyCodeResult;
    try {
      res = await verifyCode(email, form.get("code"));
    } catch (err) {
      console.error("verifyCode failed:", err instanceof Error ? err.message : String(err));
      return { step: "code", email, message: GENERIC };
    }
    // redirect кидає виняток, тож стоїть поза try. Новий акаунт іде
    // налаштовувати профіль, той, хто повернувся, у свій кабінет.
    if (res.ok) redirect(res.created ? "/welcome" : "/account");
    if (res.reason === "invalid_email") return { step: "email", email, message: verifyCodeMessage(res, UNAVAILABLE) };
    return { step: "code", email, message: verifyCodeMessage(res, UNAVAILABLE) };
  }

  // intent === "send": перший код або новий замість старого.
  let res: RequestCodeResult;
  try {
    res = await requestCode(email, clientIp(await headers()));
  } catch (err) {
    console.error("requestCode failed:", err instanceof Error ? err.message : String(err));
    return { step: prev.step, email, message: GENERIC };
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

export async function signOutAction(): Promise<void> {
  await signOut();
  redirect("/");
}
