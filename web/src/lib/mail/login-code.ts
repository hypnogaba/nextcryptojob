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
