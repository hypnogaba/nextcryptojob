import { normalizeSite } from "@/lib/identity/normalize";

/**
 * Сайт компанії й перевірка домену поштою власника (специфікація CRM, 6.1).
 *
 * Домен позначаємо перевіреним, коли пошта людини, що реєструє компанію
 * (або власника, що міняє сайт), лежить на домені сайту або його піддомені,
 * і жоден з двох не є безкоштовною поштою. Пошта в users.email підтверджена
 * кодом з листа (lib/auth/email-code.ts), тож вона доводить доступ до скриньки.
 * Перевірка через DNS TXT: later.
 */

/** Безкоштовні поштові сервіси: на них скриньку може завести будь-хто. */
export const FREE_MAIL_DOMAINS: readonly string[] = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "icloud.com",
  "me.com",
  "mac.com",
  "mail.ru",
  "ukr.net",
  "yandex.ru",
  "yandex.com",
  "zoho.com",
  "tutanota.com",
  "tuta.io",
  "mail.com",
  "qq.com",
  "163.com",
];

/** Сервіси з доменами в багатьох країнах: gmx.de, gmx.net, yahoo.co.uk, hotmail.fr… */
const FREE_MAIL_FAMILY = /^(?:gmx|yahoo|hotmail|outlook|live|yandex|web)\.[a-z]{2,3}(?:\.[a-z]{2})?$/;

export type SiteResult = { ok: true; website: string; domain: string } | { ok: false; error: string };

/**
 * Адреса сайту так само, як identities.site (https, хост нижнім регістром, без
 * кінцевого `/`), і домен: хост без `www.`.
 */
export function companySite(input: string): SiteResult {
  const site = normalizeSite(input);
  if (!site.ok) return { ok: false, error: site.error };
  const host = new URL(site.value).hostname;
  return { ok: true, website: site.value, domain: host.replace(/^www\./, "") };
}

/** Частина адреси після `@`, нижнім регістром; null для не-адреси. */
export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return null;
  return email
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
}

/** Чи домен належить безкоштовній пошті (або є її піддоменом). */
export function isFreeMailDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  if (FREE_MAIL_FAMILY.test(d)) return true;
  return FREE_MAIL_DOMAINS.some((free) => d === free || d.endsWith(`.${free}`));
}

/**
 * Чи пошта доводить домен сайту: пошта на тому самому домені або на його
 * піддомені (dana@eng.acme.io для acme.io), і ні пошта, ні сайт не на
 * безкоштовній пошті. Навпаки (сайт jobs.acme.io, пошта acme.io) не рахуємо:
 * правило специфікації лише «домен сайту або піддомен».
 */
export function emailProvesDomain(email: string | null | undefined, domain: string | null | undefined): boolean {
  const mail = emailDomain(email);
  const site = domain?.trim().toLowerCase().replace(/^www\./, "");
  if (!mail || !site || !site.includes(".")) return false;
  if (isFreeMailDomain(site) || isFreeMailDomain(mail)) return false;
  return mail === site || mail.endsWith(`.${site}`);
}
