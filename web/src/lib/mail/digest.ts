import { cleanText, safeUrl, shortDate } from "@/lib/digest/format";
import { jobVia } from "@/lib/jobs/link";
import { companySiteUrl } from "@/lib/jobs/token";
import { DIGEST_FROM } from "./cloudflare";
import type { MailMessage } from "./index";
import { escapeHtml, MAIL_DISPLAY, MAIL_FAINT, MAIL_INK, MAIL_LINE, MAIL_MUTED, MAIL_SOFT, mailButton, mailLayout } from "./layout";
import { logoPath } from "@/lib/jobs/companies";

/**
 * Лист щоденної добірки (W7). Вигляд як у листах Getro (власник 17.09, замість плиток варіанта 5):
 * біле полотно, рядок на вакансію з квадратним значком компанії ліворуч, чорна кнопка «See all your
 * jobs», рамка з layout.ts. Вакансії приходять з чужих дощок через engine,
 * тож кожне поле в HTML екрануємо, а посиланням стає лише адреса http(s) або mailto.
 * Текст англійською, без довгого тире. Відписка одним натисканням: заголовки
 * List-Unsubscribe (RFC 8058) і видиме посилання «Pause daily jobs» унизу.
 */

export type DigestEmailJob = {
  position: number;
  title: string;
  company: string;
  location: string | null;
  salary: string | null;
  why: string;
  url: string;
  /** Не null лише для вакансій компаній: «Posted by {Company} on NextCryptoJob». */
  posted_by: string | null;
  /** Оцінка дошки («est. $180k to $225k (web3.career estimate)»), лише без зарплати; не зарплата. */
  salary_estimate?: string | null;
  /** Одне-два речення про компанію, якщо знаємо. */
  about?: string | null;
  /** Домен сайту компанії («arbitrum.io»), з 14.09.2026, необов'язкове: лист робить з нього посилання https. */
  company_domain?: string | null;
  /** Рядок токена «$ARB $0.42 · MC $1.9B · +3.1%» (з 14.09.2026, необов'язкове), лише свіжі ціни. */
  token?: string | null;
  /** id вакансії на сайті (з 16.09.2026): плитка веде на /jobs/<id>; старий engine поля не шле. */
  job_id?: string | null;
};

export { escapeHtml };

export const DIGEST_FOOTER_REASON = "You get this because you turned on daily jobs on NextCryptoJob.";

type Job = {
  title: string; meta: string; why: string; url: string | null; postedBy: string | null; via: string | null;
  estimate: string | null; about: string | null; companySite: string | null; token: string | null;
  /** Окремо від meta: у HTML це підпис плитки й чипи (варіант 5), у тексті лишається той самий рядок. */
  place: string; salary: string | null;
  /** Наша сторінка вакансії (/jobs/<id>) або null, якщо engine не прислав id. */
  ours: string | null;
  company: string; location: string | null;
  /** Значок компанії на нашому сайті (/api/logo/<домен>), або null без домену. */
  logo: string | null;
};

function tidy(j: DigestEmailJob, site: string): Job {
  const meta = [cleanText(j.company, 100), j.location ? cleanText(j.location, 100) : null, j.salary ? cleanText(j.salary, 60) : null];
  return {
    title: cleanText(j.title, 200),
    meta: meta.filter(Boolean).join(" · "),
    place: [cleanText(j.company, 100), j.location ? cleanText(j.location, 100) : null].filter(Boolean).join(" · "),
    salary: j.salary ? cleanText(j.salary, 60) : null,
    why: cleanText(j.why, 300),
    // Адреса як є (safeUrl лише перевіряє): умови web3.career забороняють міняти apply_url.
    url: safeUrl(j.url),
    postedBy: j.posted_by ? cleanText(j.posted_by, 100) : null,
    via: j.posted_by ? null : jobVia(j.url),
    estimate: !j.salary && j.salary_estimate ? cleanText(j.salary_estimate, 120) : null,
    about: j.about ? cleanText(j.about, 240) : null,
    // companySiteUrl ще раз перевіряє домен (захист від чужих даних, як safeUrl вище).
    companySite: companySiteUrl(j.company_domain),
    ours: j.job_id ? new URL(`/jobs/${encodeURIComponent(j.job_id)}`, site).toString() : null,
    token: j.token ? cleanText(j.token, 80) : null,
    company: cleanText(j.company, 100),
    location: j.location ? cleanText(j.location, 100) : null,
    logo: (() => {
      const path = logoPath(j.company_domain);
      return path ? new URL(path, site).toString() : null;
    })(),
  };
}

/** «We checked 1,437 live crypto jobs. These 5 fit you best.» (як checkedLine в engine/src/digest/deliver.ts). */
export function checkedLine(checked: number | null | undefined, shown: number): string | null {
  if (!checked || checked < shown || shown <= 0) return null;
  const these = shown === 1 ? "This one fits" : `These ${shown} fit`;
  return `We checked ${checked.toLocaleString("en-US")} live crypto job${checked === 1 ? "" : "s"}. ${these} you best.`;
}

/** Квадрат логотипа компанії в рядку вакансії, як у листах Getro. */
const LOGO = 56;

/**
 * Квадрат ліворуч від вакансії: значок компанії з /api/logo (лише домени реєстру), інакше перша
 * літера назви на сірому. Якщо значок не завантажився, лишиться сірий квадрат з тією ж літерою в alt.
 */
function logoCell(j: Job): string {
  const letter = escapeHtml((j.company.match(/[A-Za-z0-9]/)?.[0] ?? "•").toUpperCase());
  const box = `width:${LOGO}px;height:${LOGO}px;border-radius:8px;background:${MAIL_SOFT};border:1px solid ${MAIL_LINE}`;
  const inner = j.logo
    ? `<img src="${escapeHtml(j.logo)}" width="${LOGO}" height="${LOGO}" alt="${letter}" ` +
      `style="display:block;border:0;border-radius:8px;width:${LOGO}px;height:${LOGO}px;font-size:22px;font-weight:700;color:${MAIL_MUTED};text-align:center;line-height:${LOGO}px">`
    : `<div style="width:${LOGO}px;height:${LOGO}px;line-height:${LOGO}px;text-align:center;font-size:22px;font-weight:700;color:${MAIL_MUTED}">${letter}</div>`;
  // Рамка на внутрішньому div, не на комірці: комірка тягнеться на всю висоту рядка.
  return `<td width="${LOGO + 2}" valign="top" style="width:${LOGO + 2}px"><div style="${box};overflow:hidden">${inner}</div></td>`;
}

/**
 * Блок картки під кнопкою: печатка, як на картці людини, і шлях до неї. Лише в нас, у Getro такого нема.
 */
function cardBlock(site: string): string {
  const seal = new URL("/brand/email-seal.png", site).toString();
  const profile = new URL("/profile", site).toString();
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `style="margin:0 0 28px;background:${MAIL_SOFT};border:1px solid ${MAIL_LINE};border-radius:14px"><tr>` +
    `<td width="72" valign="middle" style="padding:18px 0 18px 18px;width:72px">` +
    `<img src="${escapeHtml(seal)}" width="64" height="64" alt="" style="display:block;border:0;width:64px;height:64px"></td>` +
    `<td valign="middle" style="padding:18px 18px 18px 16px">` +
    `<div style="font-family:${MAIL_DISPLAY};font-size:17px;font-weight:700;color:${MAIL_INK}">Your score card</div>` +
    `<div style="margin-top:2px;font-size:14px;line-height:1.5;color:${MAIL_MUTED}">Picks follow your score. Connect more sources and they get sharper. ` +
    `<a href="${escapeHtml(profile)}" style="color:${MAIL_INK};font-weight:600">Open your card</a></div>` +
    `</td></tr></table>`
  );
}

export type DigestEmailInput = {
  localDate: string;
  jobs: DigestEmailJob[];
  /** Походження сайту з оточення (lib/site.ts), не з запиту. */
  site: string;
  /** Підписана адреса відписки (lib/digest/unsubscribe.ts). */
  unsubscribeUrl: string;
  /** Скільки живих вакансій переглянув підбір; null, якщо engine не сказав. */
  checked?: number | null;
};

export function digestEmail(input: DigestEmailInput): Omit<MailMessage, "to"> {
  const jobs = [...input.jobs].sort((a, b) => a.position - b.position).map((j) => tidy(j, input.site));
  const n = jobs.length;
  const heading = `Your ${n} crypto job${n === 1 ? "" : "s"} for ${shortDate(input.localDate)}`;
  const jobsUrl = new URL("/jobs", input.site).toString();
  const settingsUrl = new URL("/settings", input.site).toString();
  const pauseUrl = input.unsubscribeUrl;
  const checked = checkedLine(input.checked, n);

  const textBlocks = jobs.map((j, i) =>
    [
      `${i + 1}. ${j.title}`,
      j.meta,
      j.estimate,
      j.why,
      j.about,
      // Сайт компанії і токен одним рядком (db/jobs 0004/0005), як companyLineHtml в engine.
      [j.companySite, j.token].filter(Boolean).join(" · ") || null,
      j.postedBy ? `Posted by ${j.postedBy} on NextCryptoJob` : null,
      j.via ? `via ${j.via}` : null,
      j.ours ? `Open in your jobs: ${j.ours}` : null,
      j.url ? (j.ours ? `Apply directly: ${j.url}` : j.url) : null,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  const text =
    [
      checked ? `${heading}\n${checked}` : heading,
      ...textBlocks,
      [
        `All jobs we sent you: ${jobsUrl}`,
        `Change the channel or the hour: ${settingsUrl}`,
        `Pause daily jobs: ${pauseUrl}`,
        DIGEST_FOOTER_REASON,
      ].join("\n"),
    ].join("\n\n") + "\n";

  const htmlJobs = jobs
    .map((j) => {
      // Раунд 6 (власник 16.09): назва веде на НАШУ сторінку вакансії, звідти людина подається.
      // Пряме посилання на джерело лишається окремим рядком, follow, як вимагають умови web3.career.
      const openHref = j.ours ?? j.url;
      const title = escapeHtml(j.title);
      const titleHtml = openHref
        ? `<a href="${escapeHtml(openHref)}" style="color:${MAIL_INK};text-decoration:none">${title}</a>`
        : title;
      const company = j.companySite
        ? `<a href="${escapeHtml(j.companySite)}" style="color:${MAIL_MUTED};text-decoration:none">${escapeHtml(j.company)}</a>`
        : escapeHtml(j.company);
      const money = [j.salary ?? j.estimate, j.token].filter(Boolean).map((t) => escapeHtml(t!)).join(" &nbsp;·&nbsp; ");
      // Кнопка «Apply» (17.09, власник: «слово податися»): веде туди ж, куди назва (наша сторінка, звідти подача).
      const apply = openHref
        ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px"><tr>` +
          `<td style="background:${MAIL_INK};border-radius:10px"><a href="${escapeHtml(openHref)}" style="display:inline-block;` +
          `padding:8px 16px;font-size:14px;font-weight:600;line-height:1;color:#ffffff;text-decoration:none;border-radius:10px">Apply</a></td>` +
          // Вакансія компанії й так живе в нас: друге посилання вело б на ту саму сторінку.
          (j.ours && j.url && new URL(j.url).origin !== new URL(input.site).origin
            ? `<td style="padding-left:12px;font-size:13px"><a href="${escapeHtml(j.url)}" style="color:${MAIL_FAINT}">or apply directly</a></td>`
            : "") +
          `</tr></table>`
        : "";
      const links = [
        j.postedBy ? `Posted by ${escapeHtml(j.postedBy)} on NextCryptoJob` : "",
        j.via ? `via ${escapeHtml(j.via)}` : "",
      ].filter(Boolean).join(" &nbsp;·&nbsp; ");
      const line = (html: string, style: string) => `<div style="${style}">${html}</div>`;
      return (
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 26px"><tr>` +
        logoCell(j) +
        `<td valign="top" style="padding-left:18px">` +
        line(titleHtml, `font-family:${MAIL_DISPLAY};font-size:19px;line-height:1.3;color:${MAIL_INK};font-weight:500`) +
        line(company, `margin-top:3px;font-size:16px;line-height:1.4;color:${MAIL_MUTED}`) +
        (j.location ? line(escapeHtml(j.location), `font-size:16px;line-height:1.4;color:${MAIL_MUTED}`) : "") +
        (money ? line(money, `margin-top:4px;font-size:14px;line-height:1.4;color:${MAIL_INK};font-weight:600`) : "") +
        line(escapeHtml(j.why), `margin-top:6px;font-size:14px;line-height:1.5;color:${MAIL_MUTED}`) +
        (links ? line(links, `margin-top:4px;font-size:13px;line-height:1.5;color:${MAIL_FAINT}`) : "") +
        apply +
        `</td></tr></table>`
      );
    })
    .join("");
  const p = (html: string, style = "") => `<p style="margin:0 0 14px;${style}">${html}</p>`;
  const body =
    `<h1 style="margin:0 0 32px;font-family:${MAIL_DISPLAY};font-size:30px;line-height:1.2;font-weight:500;letter-spacing:-0.01em;color:${MAIL_INK}">` +
    `${n} new crypto job${n === 1 ? "" : "s"} matching your profile</h1>` +
    p(`&#128075; ${escapeHtml(checked ?? `Here ${n === 1 ? "is" : "are"} today's best match${n === 1 ? "" : "es"} for you:`)}`, "margin-bottom:24px") +
    htmlJobs +
    `<div style="height:8px;line-height:8px">&nbsp;</div>` +
    mailButton(jobsUrl, "See all your jobs") +
    cardBlock(input.site) +
    p(escapeHtml(DIGEST_FOOTER_REASON)) +
    p(`To change the channel or the hour, <a href="${escapeHtml(settingsUrl)}" style="color:${MAIL_INK}">open your settings</a>.`);
  const afterBody =
    `<p style="margin:22px 0 0"><a href="${escapeHtml(pauseUrl)}" style="color:${MAIL_FAINT}">Pause daily jobs</a></p>`;
  const html = mailLayout({ site: input.site, preheader: checked ?? heading, body, afterBody });

  // Email Service приймає List-Unsubscribe лише з https (не http), і One-Click лише разом з ним.
  const headers = pauseUrl.startsWith("https://")
    ? { "List-Unsubscribe": `<${pauseUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
    : undefined;
  return { subject: heading, text, html, from: DIGEST_FROM, ...(headers ? { headers } : {}) };
}
