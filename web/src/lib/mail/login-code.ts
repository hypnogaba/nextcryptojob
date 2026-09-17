import { DEFAULT_SITE_URL } from "@/lib/site";
import type { MailMessage } from "./index";
import { MAIL_INK, MAIL_LINE, MAIL_SOFT, mailLayout } from "./layout";

/** Листи з кодом складаються без оточення під рукою, тож знак і посилання з домену за замовчуванням. */
const SITE = DEFAULT_SITE_URL;

/** Тіло листа з кодом у рамці layout.ts: заголовок, код у сірій плашці, решта рядків абзацами. */
function codeHtml(heading: string, lead: string, code: string, rest: string[]): string {
  const p = (t: string) => `<p style="margin:0 0 14px">${t}</p>`;
  const body =
    `<h1 style="margin:0 0 24px;font-size:28px;line-height:1.25;font-weight:400;color:${MAIL_INK}">${heading}</h1>` +
    p(lead) +
    `<div style="margin:8px 0 24px;display:inline-block;padding:14px 22px;background:${MAIL_SOFT};border:1px solid ${MAIL_LINE};` +
    `border-radius:8px;font-size:32px;font-weight:600;letter-spacing:6px;font-family:ui-monospace,Menlo,Consolas,monospace;color:${MAIL_INK}">${code}</div>` +
    rest.map(p).join("");
  return mailLayout({ site: SITE, preheader: `${lead} ${code}`, body });
}

/** Лист з кодом входу. Англійською; у HTML посилання лише на сайт у шапці й підвалі. */
export function loginCodeEmail(
  code: string,
  ttlMinutes: number,
): Omit<MailMessage, "to"> {
  const subject = `Your NextCryptoJob code: ${code}`;
  const lines = [
    `Your NextCryptoJob sign-in code is ${code}.`,
    `It expires in ${ttlMinutes} minutes.`,
    "If you did not ask for it, ignore this email.",
    "Never share this code. NextCryptoJob will never ask you for it.",
  ];
  const text = lines.join("\n\n") + "\n";
  // Код лише з цифр, тож екранувати нічого; решта рядків наші.
  const html = codeHtml("Your sign-in code", "Your NextCryptoJob sign-in code is", code, lines.slice(1));
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
  const subject = `Confirm your email for NextCryptoJob`;
  const lines = [
    `Your code to add this email to your NextCryptoJob profile is ${code}.`,
    `It expires in ${ttlMinutes} minutes.`,
    "If you did not ask for it, ignore this email. Nobody can add your email without this code.",
    "Never share this code. NextCryptoJob will never ask you for it.",
  ];
  const text = lines.join("\n\n") + "\n";
  const html = codeHtml("Confirm your email", "Your code to add this email to your NextCryptoJob profile is", code, lines.slice(1));
  return { subject, text, html };
}
