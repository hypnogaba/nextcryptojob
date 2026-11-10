import type { MetadataRoute } from "next";
import { SITE } from "./sitemap";

/**
 * Роботи пошуку в AI-помічниках. Правило `*` їх і так пускає, але окрема група робить намір
 * явним: Claude шукає через Claude-SearchBot і відкриває сторінку на прохання людини як
 * Claude-User, ChatGPT так само через OAI-SearchBot і ChatGPT-User. Без них сайт не потрапить
 * у відповіді помічників. Робот, що бачить свою групу, правило `*` не читає, тому заборони ті самі.
 */
export const AI_SEARCH_BOTS = ["Claude-SearchBot", "Claude-User", "OAI-SearchBot", "ChatGPT-User", "PerplexityBot"];

/** Не сторінки: перенаправлення "Apply" з лічильником (/jobs/<id>/apply) і вхід конектора (/oauth/). */
const DISALLOW = ["/jobs/*/apply", "/oauth/"];

/** robots.txt: сайт відкритий для пошуковиків і помічників. Карта сайту: app/sitemap.ts. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: DISALLOW },
      { userAgent: AI_SEARCH_BOTS, allow: "/", disallow: DISALLOW },
    ],
    sitemap: new URL("/sitemap.xml", SITE).toString(),
  };
}
