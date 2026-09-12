"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
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

function wait(minutes: number | undefined): string {
  const n = Math.max(1, minutes ?? 1);
  return n === 1 ? "1 minute" : `${n} minutes`;
}

function requestMessage(res: Exclude<RequestCodeResult, { ok: true }>): LoginMessage {
  switch (res.reason) {
    case "invalid_email":
      return { tone: "error", text: "Enter a valid email address." };
    case "email_unavailable":
      return { tone: "info", text: "Email sign-in opens soon." };
    case "rate_limited":
      return { tone: "error", text: `Too many codes requested. Try again in ${wait(res.retryAfterMinutes)}.` };
    case "send_failed":
      return { tone: "error", text: "We could not send the email. Try again in a minute." };
  }
}

function verifyMessage(res: Exclude<VerifyCodeResult, { ok: true }>): LoginMessage {
  switch (res.reason) {
    case "invalid_email":
      return { tone: "error", text: "Enter a valid email address." };
    case "invalid_code":
      return { tone: "error", text: "Enter the 6-digit code from the email." };
    case "email_unavailable":
      return { tone: "info", text: "Email sign-in opens soon." };
    case "rate_limited":
      return { tone: "error", text: `Too many tries. Try again in ${wait(res.retryAfterMinutes)}.` };
    case "expired":
      return { tone: "error", text: "This code has expired. Send a new one." };
    case "wrong_code": {
      const left = res.attemptsLeft ?? 0;
      return { tone: "error", text: `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left.` };
    }
    case "too_many_attempts":
      return { tone: "error", text: "Too many wrong tries. Send a new code." };
  }
}

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
    if (res.reason === "invalid_email") return { step: "email", email, message: verifyMessage(res) };
    return { step: "code", email, message: verifyMessage(res) };
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
  return { step, email, message: requestMessage(res) };
}

export async function signOutAction(): Promise<void> {
  await signOut();
  redirect("/");
}
