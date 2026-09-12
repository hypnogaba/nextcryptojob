import type { MailMessage } from "./index";

/** Лист з кодом входу. Простий текст, англійською, без посилань. */
export function loginCodeEmail(
  code: string,
  ttlMinutes: number,
): Omit<MailMessage, "to"> {
  const subject = `Your NextCryptoJob code: ${code}`;
  const lines = [
    `Your NextCryptoJob sign-in code is ${code}.`,
    `It expires in ${ttlMinutes} minutes.`,
    "If you did not ask for it, ignore this email.",
  ];
  const text = lines.join("\n\n") + "\n";
  // Код лише з цифр, тож екранувати нічого; решта рядків наші.
  const html =
    `<p>Your NextCryptoJob sign-in code is</p>` +
    `<p style="font-size:28px;font-weight:600;letter-spacing:4px;font-family:monospace">${code}</p>` +
    `<p>It expires in ${ttlMinutes} minutes.</p>` +
    `<p>If you did not ask for it, ignore this email.</p>`;
  return { subject, text, html };
}

/**
 * Лист з кодом, щоб додати цю пошту до профілю, де вже є сесія (вхід через
 * Telegram). Інший текст, ніж у входу: людина має розуміти, що саме вона
 * підтверджує, і що без коду її пошту ніхто не додасть.
 */
export function addEmailCodeEmail(
  code: string,
  ttlMinutes: number,
): Omit<MailMessage, "to"> {
  const subject = `Your NextCryptoJob code: ${code}`;
  const lines = [
    `Your code to add this email to your NextCryptoJob profile is ${code}.`,
    `It expires in ${ttlMinutes} minutes.`,
    "If you did not ask for it, ignore this email. Nobody can add your email without this code.",
  ];
  const text = lines.join("\n\n") + "\n";
  const html =
    `<p>Your code to add this email to your NextCryptoJob profile is</p>` +
    `<p style="font-size:28px;font-weight:600;letter-spacing:4px;font-family:monospace">${code}</p>` +
    `<p>It expires in ${ttlMinutes} minutes.</p>` +
    `<p>If you did not ask for it, ignore this email. Nobody can add your email without this code.</p>`;
  return { subject, text, html };
}
