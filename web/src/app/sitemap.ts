import type { MetadataRoute } from "next";

/**
 * Карта сайту: лише сторінки, які ми справді пускаємо в пошук. Вакансії зі сканування сюди не
 * йдуть: вони `noindex` (не наші оголошення, `app/jobs/[id]/page.tsx`), і картки людей теж
 * (`app/c/[slug]/page.tsx`: людина ділиться карткою сама).
 *
 * `lastModified` не вигадуємо: ставимо день збірки, бо саме тоді текст сторінки востаннє змінився.
 */
const PAGES: { path: string; priority: number; changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"] }[] = [
  { path: "/", priority: 1, changeFrequency: "daily" },
  { path: "/scoring", priority: 0.8, changeFrequency: "monthly" },
  { path: "/company", priority: 0.8, changeFrequency: "monthly" },
  { path: "/leaderboard", priority: 0.7, changeFrequency: "daily" },
  { path: "/faq", priority: 0.6, changeFrequency: "monthly" },
  { path: "/sources", priority: 0.6, changeFrequency: "weekly" },
  { path: "/agents", priority: 0.5, changeFrequency: "monthly" },
  { path: "/contact", priority: 0.4, changeFrequency: "yearly" },
  { path: "/terms", priority: 0.3, changeFrequency: "yearly" },
  { path: "/terms/companies", priority: 0.3, changeFrequency: "yearly" },
  { path: "/privacy", priority: 0.3, changeFrequency: "yearly" },
];

/** Адреса сайту для абсолютних посилань у карті (та сама, що metadataBase в layout). */
export const SITE = process.env.SITE_URL ?? "https://nextcryptojob.xyz";

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return PAGES.map((p) => ({ url: new URL(p.path, SITE).toString(), lastModified, changeFrequency: p.changeFrequency, priority: p.priority }));
}
