import { DIGEST_FROM } from "./cloudflare";
import type { MailMessage } from "./index";
import { escapeHtml, MAIL_DISPLAY, MAIL_FAINT, MAIL_INK, mailButton, mailLayout } from "./layout";

/**
 * Листи воронки (аудит 29.09, F): «Still looking?», «No new jobs fit you this week» і нагадування
 * тому, хто не закінчив анкету. Один вигляд з листом добірки (layout.ts), англійською, короткими
 * реченнями. Відписка в кожному: заголовки List-Unsubscribe (лише https) і видиме «Pause daily jobs».
 */

type Base = { site: string; unsubscribeUrl: string };

const h1 = (text: string) =>
  `<h1 style="margin:0 0 24px;font-family:${MAIL_DISPLAY};font-size:28px;line-height:1.2;font-weight:500;letter-spacing:-0.01em;color:${MAIL_INK}">${escapeHtml(text)}</h1>`;
const p = (html: string) => `<p style="margin:0 0 14px">${html}</p>`;
const link = (href: string, label: string) => `<a href="${escapeHtml(href)}" style="color:${MAIL_INK};font-weight:600">${escapeHtml(label)}</a>`;

function finish(base: Base, subject: string, text: string, body: string, preheader: string): Omit<MailMessage, "to"> {
  const afterBody = `<p style="margin:22px 0 0"><a href="${escapeHtml(base.unsubscribeUrl)}" style="color:${MAIL_FAINT}">Pause daily jobs</a></p>`;
  const headers = base.unsubscribeUrl.startsWith("https://")
    ? { "List-Unsubscribe": `<${base.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
    : undefined;
  return {
    subject,
    text: `${text}\n\nPause daily jobs: ${base.unsubscribeUrl}\n`,
    html: mailLayout({ site: base.site, preheader, body, afterBody }),
    from: DIGEST_FROM,
    ...(headers ? { headers } : {}),
  };
}

/** «Still looking?»: одна кнопка «Yes». Без відповіді за 3 дні добірка на паузі, вийти з неї можна в налаштуваннях. */
export function stillLookingEmail(input: Base & { yesUrl: string }): Omit<MailMessage, "to"> {
  const settings = new URL("/settings", input.site).toString();
  const subject = "Still looking for a crypto job?";
  const text = [
    subject,
    "You have not opened NextCryptoJob for two weeks.",
    `Want to keep your daily jobs? Tap yes: ${input.yesUrl}`,
    `If we hear nothing in 3 days, we pause your daily jobs. You can turn them back on in settings: ${settings}`,
  ].join("\n\n");
  const body =
    h1("Still looking for a crypto job?") +
    p("You have not opened NextCryptoJob for two weeks.") +
    p("Want to keep your daily jobs?") +
    mailButton(input.yesUrl, "Yes, keep them coming") +
    p(`If we hear nothing in 3 days, we pause your daily jobs. You can turn them back on in ${link(settings, "settings")}.`);
  return finish(input, subject, text, body, "Tap yes to keep your daily jobs.");
}

/** Пусті дні: що нічого не підійшло і три способи розширити пошук. */
export function emptyWeekEmail(input: Base & { options: Array<{ label: string; url: string }> }): Omit<MailMessage, "to"> {
  const settings = new URL("/settings", input.site).toString();
  const subject = "No new jobs fit you this week";
  const text = [
    subject,
    "We looked every day. Nothing matched your roles and place.",
    "You can widen your search:",
    ...input.options.map((o) => `- ${o.label}: ${o.url}`),
    `Daily jobs settings: ${settings}`,
  ].join("\n\n");
  const list = input.options
    .map((o) => `<li style="margin:0 0 8px">${link(o.url, o.label)}</li>`)
    .join("");
  const body =
    h1("No new jobs fit you this week") +
    p("We looked every day. Nothing matched your roles and place.") +
    p("You can widen your search:") +
    `<ul style="margin:0 0 20px;padding-left:20px">${list}</ul>` +
    mailButton(input.options[0]?.url ?? settings, input.options[0]?.label ?? "Open settings") +
    p(`Daily jobs settings: ${link(settings, "open settings")}.`);
  return finish(input, subject, text, body, "Nothing matched this week. Here is how to widen your search.");
}

/** Нагадування тому, хто не закінчив анкету: одне, через добу. */
export function onboardingReminderEmail(input: Base & { startUrl: string }): Omit<MailMessage, "to"> {
  const subject = "Your NextCryptoJob setup is not finished";
  const text = [subject, "Tell us the work you want and we send you the 5 best crypto jobs every day.", `Finish setup: ${input.startUrl}`].join("\n\n");
  const body =
    h1("Your setup is not finished") +
    p("Tell us the work you want and we send you the 5 best crypto jobs every day.") +
    mailButton(input.startUrl, "Finish setup");
  return finish(input, subject, text, body, "It takes a minute.");
}
