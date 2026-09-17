/**
 * Спільна рамка HTML-листів (17.09, власник: «щось типу такого», зразок листи Getro).
 * Біле полотно, колонка 600 px ліворуч-по-центру, угорі знак і назва, унизу риска й тихий підвал.
 * Кольори з сайту (globals.css, раунд 4 «Frost»): чорнило замість синього Getro.
 * Наше (власник 17.09: «щоб була наша ізюминка»): шапка = печатка + назва шрифтом Funnel Display,
 * як на сайті (public/brand/email-logo.png), заголовки тим самим шрифтом, кнопки з кутом 10 px.
 * Верстка таблицями з вбудованими стилями: так лист однаково виглядає в Gmail, Apple Mail і Outlook.
 * Картинки лише PNG з нашого сайту: Gmail не показує SVG.
 */

export const MAIL_INK = "#0e0f12";
export const MAIL_TEXT = "#3a3d44";
export const MAIL_MUTED = "#5d616b";
export const MAIL_FAINT = "#8a8e97";
export const MAIL_LINE = "#e8e9ec";
export const MAIL_SOFT = "#f5f6f7";
export const MAIL_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
/** Шрифт заголовків сайту; Apple Mail і iOS його підтягнуть, Gmail покаже запасний. */
export const MAIL_DISPLAY = `'Funnel Display',${MAIL_FONT}`;

/** Екранування для тексту й атрибутів у лапках. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Кнопка з таблиці: тримає тло й відступи навіть у Outlook. */
export function mailButton(href: string, label: string): string {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 28px"><tr>` +
    `<td style="background:${MAIL_INK};border-radius:10px">` +
    `<a href="${escapeHtml(href)}" style="display:inline-block;padding:13px 24px;font-family:${MAIL_FONT};` +
    `font-size:16px;font-weight:600;line-height:1;color:#ffffff;text-decoration:none;border-radius:10px">${escapeHtml(label)}</a>` +
    `</td></tr></table>`
  );
}

export type MailLayoutInput = {
  /** Походження сайту (lib/site.ts): звідти знак і посилання в шапці. */
  site: string;
  /** Прихований рядок попереднього перегляду в списку листів. */
  preheader?: string;
  /** Уже зібраний і екранований HTML тіла. */
  body: string;
  /** Уже зібраний і екранований HTML над рискою підвалу (відписка тощо). */
  afterBody?: string;
};

export function mailLayout(input: MailLayoutInput): string {
  const home = new URL("/", input.site).toString();
  const logo = new URL("/brand/email-logo.png", input.site).toString();
  const year = new Date().getUTCFullYear();
  const preheader = input.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(input.preheader)}</div>`
    : "";
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">` +
    `<link href="https://fonts.googleapis.com/css2?family=Funnel+Display:wght@500;700&display=swap" rel="stylesheet">` +
    `</head><body style="margin:0;padding:0;background:#ffffff">` +
    preheader +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff"><tr>` +
    `<td align="center" style="padding:40px 20px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `style="max-width:600px;font-family:${MAIL_FONT};font-size:16px;line-height:1.5;color:${MAIL_TEXT};text-align:left">` +
    // Шапка: печатка й назва однією картинкою, як на сайті.
    `<tr><td style="padding:0 0 36px">` +
    `<a href="${escapeHtml(home)}"><img src="${escapeHtml(logo)}" width="300" height="48" alt="NextCryptoJob" ` +
    `style="display:block;border:0;width:300px;height:48px;font-family:${MAIL_DISPLAY};font-size:26px;font-weight:700;color:${MAIL_INK}"></a>` +
    `</td></tr>` +
    `<tr><td>${input.body}</td></tr>` +
    (input.afterBody ? `<tr><td>${input.afterBody}</td></tr>` : "") +
    // Підвал за рискою, як у Getro.
    `<tr><td style="padding:32px 0 0"><div style="border-top:1px solid ${MAIL_LINE};height:0;line-height:0">&nbsp;</div></td></tr>` +
    `<tr><td style="padding:20px 0 0;font-size:14px;line-height:1.6;color:${MAIL_MUTED}">` +
    `<a href="${escapeHtml(home)}" style="color:${MAIL_MUTED}">NextCryptoJob</a>: crypto jobs matched to your profile.<br>` +
    `Questions? Write to <a href="mailto:hello@nextcryptojob.xyz" style="color:${MAIL_MUTED}">hello@nextcryptojob.xyz</a>.` +
    `</td></tr>` +
    `<tr><td style="padding:16px 0 0;font-size:12px;color:${MAIL_FAINT}">&copy; ${year} NextCryptoJob</td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}
