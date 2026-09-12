import { getCloudflareContext } from "@opennextjs/cloudflare";
import { headers } from "next/headers";
import { cache } from "react";
import { getCard } from "@/lib/card/store";

/** Картка за slug з D1; cache() дає одне читання на запит для сторінки й метаданих. */
export const loadCard = cache(async (slug: string) => {
  const { env } = await getCloudflareContext({ async: true });
  return getCard(env.DB, slug);
});

const FALLBACK_ORIGIN = "https://nextcryptojob.xyz";

/**
 * Адреса сайту для абсолютних посилань у метаданих (og:image мусить бути
 * абсолютним). Беремо хост запиту: зараз це workers.dev, згодом nextcryptojob.xyz,
 * і в Worker хост не підробити, бо за ним Cloudflare і маршрутизує.
 */
export async function requestOrigin(): Promise<URL> {
  const host = (await headers()).get("host");
  if (!host || !/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return new URL(FALLBACK_ORIGIN);
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  return new URL(`${local ? "http" : "https"}://${host}`);
}
