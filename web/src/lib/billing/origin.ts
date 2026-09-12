/**
 * Походження сайту з заголовків запиту: для адрес повернення Stripe і
 * прикладу curl. Так працює і workers.dev, і власний домен, і `next dev`.
 * `Origin` у server action Next уже звірив з `Host` (захист від CSRF).
 */
export function requestOrigin(h: Headers): string {
  const origin = h.get("origin");
  if (origin && /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(origin)) return origin;
  const host = h.get("host");
  if (!host || !/^[A-Za-z0-9.-]+(:\d+)?$/.test(host)) return "https://nextcryptojob.xyz";
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  return `${local ? "http" : "https"}://${host}`;
}
