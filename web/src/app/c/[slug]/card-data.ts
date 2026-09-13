import { getCloudflareContext } from "@opennextjs/cloudflare";
import { headers } from "next/headers";
import { cache } from "react";
import { currentUser } from "@/lib/auth/session";
import { isCardOwner } from "@/lib/card/owner";
import { getCard, getCardEvidence } from "@/lib/card/store";
import { cardView } from "@/lib/card/view";

/** Картка за slug з D1; cache() дає одне читання на запит для сторінки й метаданих. */
export const loadCard = cache(async (slug: string) => {
  const { env } = await getCloudflareContext({ async: true });
  return getCard(env.DB, slug);
});

/**
 * Картка з тим, що за нею стоїть (зворот, печатка з гаманця). Разом з loadCard
 * два читання D1 на запит; хто власник, у вигляд не потрапляє.
 */
export const loadCardView = cache(async (slug: string) => {
  const card = await loadCard(slug);
  if (!card) return null;
  const { env } = await getCloudflareContext({ async: true });
  return cardView(card, await getCardEvidence(env.DB, slug));
});

/** Чи дивиться власник картки: так/ні, без id людини. */
export async function loadIsOwner(slug: string): Promise<boolean> {
  const user = await currentUser();
  if (!user) return false;
  const { env } = await getCloudflareContext({ async: true });
  return isCardOwner(env.DB, slug, user.id);
}

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
