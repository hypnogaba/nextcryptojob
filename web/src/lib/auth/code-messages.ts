import type { CodeFailure, RequestCodeResult } from "./email-code";

/**
 * Тексти для людини за відповідями email-code: одні й ті самі для входу
 * (/login) і для «Add email» (/account, /settings). Відрізняється лише рядок
 * «пошта недоступна», його передає форма.
 */

export type CodeMessage = { tone: "error" | "info"; text: string };

function wait(minutes: number | undefined): string {
  const n = Math.max(1, minutes ?? 1);
  return n === 1 ? "1 minute" : `${n} minutes`;
}

export function requestCodeMessage(res: Exclude<RequestCodeResult, { ok: true }>, unavailable: string): CodeMessage {
  switch (res.reason) {
    case "invalid_email":
      return { tone: "error", text: "Enter a valid email address." };
    case "email_unavailable":
      return { tone: "info", text: unavailable };
    case "rate_limited":
      return { tone: "error", text: `Too many codes requested. Try again in ${wait(res.retryAfterMinutes)}.` };
    case "send_failed":
      return { tone: "error", text: "We could not send the email. Try again in a minute." };
  }
}

export function verifyCodeMessage(res: CodeFailure, unavailable: string): CodeMessage {
  switch (res.reason) {
    case "invalid_email":
      return { tone: "error", text: "Enter a valid email address." };
    case "invalid_code":
      return { tone: "error", text: "Enter the 6-digit code from the email." };
    case "email_unavailable":
      return { tone: "info", text: unavailable };
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
