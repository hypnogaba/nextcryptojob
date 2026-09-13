/**
 * Адреса сайту для посилань, що живуть поза запитом (листи, заголовки листів).
 * Лише з оточення (SITE_URL), ніколи з request.url чи Host: заголовок запиту
 * задає той, хто кличе, і лист не має вести туди, куди він скаже.
 */

export const DEFAULT_SITE_URL = "https://nextcryptojob.xyz";

/** Походження без кінцевого «/»: SITE_URL, якщо це https (http лише для localhost), інакше домен. */
export function siteOrigin(env: { SITE_URL?: string }): string {
  const raw = env.SITE_URL?.trim();
  if (!raw) return DEFAULT_SITE_URL;
  try {
    const u = new URL(raw);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol === "https:" || (u.protocol === "http:" && local)) return u.origin;
  } catch {
    // Криве значення: краще домен, ніж зламане посилання в листі.
  }
  return DEFAULT_SITE_URL;
}
