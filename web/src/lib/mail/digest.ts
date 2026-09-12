import { cleanText, safeUrl, shortDate } from "@/lib/digest/format";
import type { MailMessage } from "./index";

/**
 * Лист щоденної добірки (W7). Вакансії приходять з чужих дощок через engine,
 * тож кожне поле в HTML екрануємо, а посиланням стає лише адреса http(s).
 * Текст англійською, без довгого тире.
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

type Job = { title: string; meta: string; why: string; url: string | null; postedBy: string | null };

function tidy(j: DigestEmailJob): Job {
  const meta = [cleanText(j.company, 100), j.location ? cleanText(j.location, 100) : null, j.salary ? cleanText(j.salary, 60) : null];
  return {
    title: cleanText(j.title, 200),
    meta: meta.filter(Boolean).join(" · "),
    why: cleanText(j.why, 300),
    url: safeUrl(j.url),
    postedBy: j.posted_by ? cleanText(j.posted_by, 100) : null,
  };
}

const INK = "#141a1b";
const MUTED = "#58646a";
const BRAND = "#0b6e63";
const LINE = "#d5dcda";

export function digestEmail(input: { localDate: string; jobs: DigestEmailJob[]; origin: string }): Omit<MailMessage, "to"> {
  const jobs = [...input.jobs].sort((a, b) => a.position - b.position).map(tidy);
  const n = jobs.length;
  const heading = `Your ${n} crypto job${n === 1 ? "" : "s"} for ${shortDate(input.localDate)}`;
  const jobsUrl = new URL("/jobs", input.origin).toString();
  const settingsUrl = new URL("/settings", input.origin).toString();

  const textBlocks = jobs.map((j, i) =>
    [
      `${i + 1}. ${j.title}`,
      j.meta,
      j.why,
      j.postedBy ? `Posted by ${j.postedBy} on NextCryptoJob` : null,
      j.url,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  const text =
    [
      heading,
      ...textBlocks,
      [
        `All jobs we sent you: ${jobsUrl}`,
        `Change the channel or pause daily jobs: ${settingsUrl}`,
        DIGEST_FOOTER_REASON,
      ].join("\n"),
    ].join("\n\n") + "\n";

  const htmlJobs = jobs
    .map((j, i) => {
      const title = `${i + 1}. ${escapeHtml(j.title)}`;
      const titleHtml = j.url ? `<a href="${escapeHtml(j.url)}" style="color:${BRAND}">${title}</a>` : title;
      return (
        `<div style="border:1px solid ${LINE};border-radius:8px;padding:16px;margin:0 0 12px;background:#ffffff">` +
        `<p style="margin:0 0 4px;font-size:16px;font-weight:600">${titleHtml}</p>` +
        (j.meta ? `<p style="margin:0 0 8px;color:${MUTED}">${escapeHtml(j.meta)}</p>` : "") +
        `<p style="margin:0">${escapeHtml(j.why)}</p>` +
        (j.postedBy
          ? `<p style="margin:8px 0 0;color:${MUTED};font-size:13px">Posted by ${escapeHtml(j.postedBy)} on NextCryptoJob</p>`
          : "") +
        `</div>`
      );
    })
    .join("");
  const html =
    `<div style="max-width:560px;margin:0 auto;padding:24px 16px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;` +
    `font-size:15px;line-height:1.5;color:${INK}">` +
    `<h1 style="font-size:20px;line-height:1.3;margin:0 0 16px">${escapeHtml(heading)}</h1>` +
    htmlJobs +
    `<p style="margin:16px 0 0;color:${MUTED};font-size:13px">` +
    `<a href="${escapeHtml(jobsUrl)}" style="color:${BRAND}">All jobs we sent you</a>. ` +
    `<a href="${escapeHtml(settingsUrl)}" style="color:${BRAND}">Change the channel or pause daily jobs</a>.</p>` +
    `<p style="margin:8px 0 0;color:${MUTED};font-size:13px">${DIGEST_FOOTER_REASON}</p>` +
    `</div>`;

  return { subject: heading, text, html };
}
