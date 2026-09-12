import { cloudflareMailer } from "./cloudflare";
import { logMailer } from "./log";

/**
 * Пошта. Один інтерфейс, дві реалізації:
 * - Cloudflare Email Service через binding EMAIL (коли домен підключено);
 * - logMailer пише лист у журнал сервера, лише поза продакшеном.
 * У продакшені без EMAIL поштою не надсилаємо нічого (docs/contracts.md, §8).
 */

export type MailMessage = { to: string; subject: string; text: string; html: string };

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export const isProduction = (): boolean => process.env.NODE_ENV === "production";

/** Пошта з оточення або null, якщо надсилати нічим. */
export function getMailer(env: { EMAIL?: SendEmail }): Mailer | null {
  if (env.EMAIL) return cloudflareMailer(env.EMAIL);
  if (!isProduction()) return logMailer;
  return null;
}
