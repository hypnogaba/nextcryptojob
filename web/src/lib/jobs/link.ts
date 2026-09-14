import { safeUrl } from "@/lib/digest/format";

/**
 * Посилання на вакансію з чужої дошки: ЄДИНЕ місце, що вирішує rel, і воно ніколи не переписує адресу.
 *
 * Умови Web3 Jobs API (web3.career), обов'язкові, інакше доступ до API знімуть:
 *   - вести на `apply_url` посиланням follow: у rel немає nofollow (ні ugc, ні sponsored);
 *   - адресу не міняти й нічого не додавати (utm_source, utm_medium, ref): мітки вже всередині;
 *   - називати web3.career джерелом («via web3.career»).
 * Тому для web3.career rel лише "noopener" (без noreferrer: вони мають бачити, що перехід від нас),
 * для решти дошок як і було: "noopener noreferrer nofollow". Адреса в href рівно та, що в базі
 * (safeUrl лише перевіряє, не нормалізує). Пошта, Telegram і search_jobs беруть адресу так само як є.
 */

export const WEB3CAREER = "web3.career";

/** rel зовнішнього посилання на вакансію з інших дошок. */
export const EXTERNAL_JOB_REL = "noopener noreferrer nofollow";
/** rel посилання на web3.career: follow і з реферером. */
export const WEB3CAREER_REL = "noopener";

/** Хост адреси в нижньому регістрі (лише для рішення; сама адреса не міняється). */
function hostOf(url: string): string | null {
  try {
    return new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isWeb3CareerUrl(url: string | null | undefined): boolean {
  const host = url ? hostOf(url) : null;
  return host === WEB3CAREER || (host?.endsWith(`.${WEB3CAREER}`) ?? false);
}

/** Кого назвати джерелом поруч із вакансією: «web3.career» або null. */
export function jobVia(url: string | null | undefined): string | null {
  return isWeb3CareerUrl(url) ? WEB3CAREER : null;
}

/** rel для зовнішнього посилання на цю адресу. */
export function externalRel(url: string): string {
  return isWeb3CareerUrl(url) ? WEB3CAREER_REL : EXTERNAL_JOB_REL;
}

export type ExternalLink = { href: string; rel: string; via: string | null };

/**
 * Зовнішнє посилання на вакансію: href рівно вхідна адреса (safeUrl: лише http(s)/mailto, без
 * переписування), rel за правилом вище, via для підпису «via web3.career». null, якщо адреса крива.
 */
export function externalJobLink(raw: string | null | undefined): ExternalLink | null {
  const href = safeUrl(raw);
  if (!href) return null;
  return { href, rel: externalRel(href), via: jobVia(href) };
}
