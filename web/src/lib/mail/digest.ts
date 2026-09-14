import { cleanText, safeUrl, shortDate } from "@/lib/digest/format";
import { jobVia } from "@/lib/jobs/link";
import { DIGEST_FROM } from "./cloudflare";
import type { MailMessage } from "./index";

/**
 * Лист щоденної добірки (W7). Вакансії приходять з чужих дощок через engine,
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
};

/** Екранування для тексту й атрибутів у лапках. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const DIGEST_FOOTER_REASON = "You get this because you turned on daily jobs on NextCryptoJob.";

type Job = {
  title: string; meta: string; why: string; url: string | null; postedBy: string | null; via: string | null;
  estimate: string | null; about: string | null;
};

function tidy(j: DigestEmailJob): Job {
  const meta = [cleanText(j.company, 100), j.location ? cleanText(j.location, 100) : null, j.salary ? cleanText(j.salary, 60) : null];
  return {
    title: cleanText(j.title, 200),
    meta: meta.filter(Boolean).join(" · "),
    why: cleanText(j.why, 300),
    // Адреса як є (safeUrl лише перевіряє): умови web3.career забороняють міняти apply_url.
    url: safeUrl(j.url),
    postedBy: j.posted_by ? cleanText(j.posted_by, 100) : null,
    via: j.posted_by ? null : jobVia(j.url),
    estimate: !j.salary && j.salary_estimate ? cleanText(j.salary_estimate, 120) : null,
    about: j.about ? cleanText(j.about, 240) : null,
  };
}

/** «We checked 1,437 live crypto jobs. These 5 fit you best.» (як checkedLine в engine/src/digest/deliver.ts). */
export function checkedLine(checked: number | null | undefined, shown: number): string | null {
  if (!checked || checked < shown || shown <= 0) return null;
  const these = shown === 1 ? "This one fits" : `These ${shown} fit`;
  return `We checked ${checked.toLocaleString("en-US")} live crypto job${checked === 1 ? "" : "s"}. ${these} you best.`;
}

const INK = "#141a1b";
const MUTED = "#58646a";
const BRAND = "#0b6e63";
const LINE = "#d5dcda";

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
  const jobs = [...input.jobs].sort((a, b) => a.position - b.position).map(tidy);
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
      j.postedBy ? `Posted by ${j.postedBy} on NextCryptoJob` : null,
      j.via ? `via ${j.via}` : null,
      j.url,
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
    .map((j, i) => {
      const title = `${i + 1}. ${escapeHtml(j.title)}`;
      // Без rel: у листі це follow-посилання, як і вимагає web3.career.
      const titleHtml = j.url ? `<a href="${escapeHtml(j.url)}" style="color:${BRAND}">${title}</a>` : title;
      return (
        `<div style="border:1px solid ${LINE};border-radius:8px;padding:16px;margin:0 0 12px;background:#ffffff">` +
        `<p style="margin:0 0 4px;font-size:16px;font-weight:600">${titleHtml}</p>` +
        (j.meta ? `<p style="margin:0 0 8px;color:${MUTED}">${escapeHtml(j.meta)}</p>` : "") +
        (j.estimate ? `<p style="margin:0 0 8px;color:${MUTED};font-size:13px">${escapeHtml(j.estimate)}</p>` : "") +
        `<p style="margin:0">${escapeHtml(j.why)}</p>` +
        (j.about ? `<p style="margin:8px 0 0;color:${MUTED};font-size:14px">${escapeHtml(j.about)}</p>` : "") +
        (j.postedBy
          ? `<p style="margin:8px 0 0;color:${MUTED};font-size:13px">Posted by ${escapeHtml(j.postedBy)} on NextCryptoJob</p>`
          : "") +
        (j.via ? `<p style="margin:8px 0 0;color:${MUTED};font-size:13px">via ${escapeHtml(j.via)}</p>` : "") +
        `</div>`
      );
    })
    .join("");
  const html =
    `<div style="max-width:560px;margin:0 auto;padding:24px 16px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;` +
    `font-size:15px;line-height:1.5;color:${INK}">` +
    `<h1 style="font-size:20px;line-height:1.3;margin:0 ${checked ? "0 6px" : "0 16px"}">${escapeHtml(heading)}</h1>` +
    (checked ? `<p style="margin:0 0 16px;color:${MUTED}">${escapeHtml(checked)}</p>` : "") +
    htmlJobs +
    `<p style="margin:16px 0 0;color:${MUTED};font-size:13px">` +
    `<a href="${escapeHtml(jobsUrl)}" style="color:${BRAND}">All jobs we sent you</a>. ` +
    `<a href="${escapeHtml(settingsUrl)}" style="color:${BRAND}">Change the channel or the hour</a>. ` +
    `<a href="${escapeHtml(pauseUrl)}" style="color:${BRAND}">Pause daily jobs</a>.</p>` +
    `<p style="margin:8px 0 0;color:${MUTED};font-size:13px">${DIGEST_FOOTER_REASON}</p>` +
    `</div>`;

  // Email Service приймає List-Unsubscribe лише з https (не http), і One-Click лише разом з ним.
  const headers = pauseUrl.startsWith("https://")
    ? { "List-Unsubscribe": `<${pauseUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
    : undefined;
  return { subject: heading, text, html, from: DIGEST_FROM, ...(headers ? { headers } : {}) };
}
