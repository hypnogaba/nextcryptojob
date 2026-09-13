import type { Mailer } from "./index";

/**
 * Відправник листів. Адреса мусить бути на домені, підключеному до Email
 * Service; той самий рядок стоїть в allowed_sender_addresses у wrangler.jsonc.
 */
export const MAIL_FROM = { email: "login@nextcryptojob.xyz", name: "NextCryptoJob" };

/** Відправник щоденної добірки: окрема адреса, щоб лист з вакансіями не виглядав як код входу. */
export const DIGEST_FROM = { email: "jobs@nextcryptojob.xyz", name: "NextCryptoJob" };

/**
 * Cloudflare Email Service через Worker binding (send_email у wrangler.jsonc).
 * API: https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 * send() повертає { messageId } або кидає помилку з кодом (E_SENDER_NOT_VERIFIED,
 * E_RATE_LIMIT_EXCEEDED, E_RECIPIENT_SUPPRESSED тощо): її ловить той, хто надсилає.
 */
export function cloudflareMailer(binding: SendEmail): Mailer {
  return {
    async send({ to, subject, text, html, from, headers }) {
      await binding.send({ from: from ?? MAIL_FROM, to, subject, text, html, ...(headers ? { headers } : {}) });
    },
  };
}
