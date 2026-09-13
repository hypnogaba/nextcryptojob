import { getDomain, getDomainWithoutSuffix } from "tldts";
import { normalizeSite } from "@/lib/identity/normalize";

/**
 * Сайт компанії й перевірка домену поштою власника (специфікація CRM, 6.1).
 *
 * Домен позначаємо перевіреним, коли пошта людини, що реєструє компанію
 * (або власника, що міняє сайт), і сайт мають той самий зареєстрований домен
 * (eTLD+1 за Public Suffix List, разом із приватними суфіксами на кшталт
 * github.io), і жоден з них не безкоштовна чи одноразова пошта. Пошта в
 * users.email підтверджена кодом з листа (lib/auth/email-code.ts), тож вона
 * доводить доступ до скриньки. Сайт без зареєстрованого домену (com.ua,
 * ac.uk, github.io) нічого не доводить і як сайт компанії не приймається.
 * Перевірка через DNS TXT: later.
 *
 * tldts має список суфіксів у собі, без мережі й без Node API, тож працює у Worker.
 */

const PSL = { allowPrivateDomains: true } as const;

/** Безкоштовні й одноразові поштові сервіси: на них скриньку може завести будь-хто. */
export const FREE_MAIL_DOMAINS: readonly string[] = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "yahoo.com",
  "ymail.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "protonmail.ch",
  "pm.me",
  "duck.com",
  "fastmail.com",
  "fastmail.fm",
  "web.de",
  "orange.fr",
  "free.fr",
  "laposte.net",
  "mail.ru",
  "ukr.net",
  "zoho.com",
  "tutanota.com",
  "tuta.io",
  "hey.com",
  "mail.com",
  "qq.com",
  "163.com",
  "yopmail.com",
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "temp-mail.org",
];

/** Сервіси з доменами в багатьох країнах (gmx.de, gmx.co.uk, yandex.ru, yahoo.fr…): назва без суфікса. */
const FREE_MAIL_FAMILIES: readonly string[] = ["gmx", "yandex", "yahoo", "hotmail", "outlook", "live"];

export type SiteResult = { ok: true; website: string; domain: string } | { ok: false; error: string };

/**
 * Адреса сайту так само, як identities.site (https, хост нижнім регістром, без
 * кінцевого `/`), і домен: хост без `www.`. Хост мусить мати зареєстрований
 * домен: публічний суфікс (com.ua, github.io) сайтом компанії не буває.
 */
export function companySite(input: string): SiteResult {
  const site = normalizeSite(input);
  if (!site.ok) return { ok: false, error: site.error };
  const host = new URL(site.value).hostname;
  if (!registrableDomain(host)) return { ok: false, error: "Use the address of your own website, not a shared domain." };
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

/** Зареєстрований домен (eTLD+1, з приватними суфіксами) або null для суфікса й не-домену. */
export function registrableDomain(host: string | null | undefined): string | null {
  if (!host) return null;
  return getDomain(host.trim().toLowerCase().replace(/\.$/, ""), PSL);
}

/** Чи домен належить безкоштовній чи одноразовій пошті (або є її піддоменом). */
export function isFreeMailDomain(domain: string): boolean {
  const d = domain.trim().toLowerCase().replace(/\.$/, "");
  const reg = registrableDomain(d) ?? d;
  if (FREE_MAIL_DOMAINS.includes(reg)) return true;
  const name = getDomainWithoutSuffix(d, PSL);
  return name !== null && FREE_MAIL_FAMILIES.includes(name);
}

/**
 * Чи пошта доводить домен сайту: той самий зареєстрований домен (dana@eng.acme.io
 * для acme.io), обидва справжні зареєстровані домени, і ні пошта, ні сайт не на
 * безкоштовній чи одноразовій пошті.
 */
export function emailProvesDomain(email: string | null | undefined, domain: string | null | undefined): boolean {
  const mailHost = emailDomain(email);
  const siteHost = domain?.trim().toLowerCase().replace(/^www\./, "");
  if (!mailHost || !siteHost) return false;
  const mailReg = registrableDomain(mailHost);
  const siteReg = registrableDomain(siteHost);
  if (!mailReg || !siteReg) return false;
  if (isFreeMailDomain(siteHost) || isFreeMailDomain(mailHost)) return false;
  return mailReg === siteReg;
}
