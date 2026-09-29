import type { MetadataRoute } from "next";
import { CATEGORY_ROLES, indexable } from "@/lib/jobs/categories";
import { loadCategoryIndex } from "./crypto-jobs/data";

/**
 * Карта сайту: лише сторінки, які ми справді пускаємо в пошук. Вакансії зі сканування сюди не
 * йдуть: вони `noindex` (не наші оголошення, `app/jobs/[id]/page.tsx`), і картки людей теж
 * (`app/c/[slug]/page.tsx`: людина ділиться карткою сама).
 *
 * /terms/companies сюди не йде: це редирект на /terms#companies (сторінки в нього немає).
 * Категорії /crypto-jobs/<роль>[/remote] йдуть, лише коли в них є хоч CATEGORY_MIN_JOBS вакансій
 * (та сама умова ставить їм noindex, тож карта й сторінка не розходяться).
 *
 * `lastModified` не вигадуємо: ставимо день збірки, бо саме тоді текст сторінки востаннє змінився.
 */
const PAGES: { path: string; priority: number; changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"] }[] = [
  { path: "/", priority: 1, changeFrequency: "daily" },
  { path: "/crypto-jobs", priority: 0.9, changeFrequency: "daily" },
  { path: "/scoring", priority: 0.8, changeFrequency: "monthly" },
  { path: "/company", priority: 0.8, changeFrequency: "monthly" },
  { path: "/leaderboard", priority: 0.7, changeFrequency: "daily" },
  { path: "/faq", priority: 0.6, changeFrequency: "monthly" },
  { path: "/sources", priority: 0.6, changeFrequency: "weekly" },
  { path: "/agents", priority: 0.5, changeFrequency: "monthly" },
  { path: "/contact", priority: 0.4, changeFrequency: "yearly" },
  { path: "/terms", priority: 0.3, changeFrequency: "yearly" },
  { path: "/privacy", priority: 0.3, changeFrequency: "yearly" },
];

/** Адреса сайту для абсолютних посилань у карті (та сама, що metadataBase в layout). */
export const SITE = process.env.SITE_URL ?? "https://nextcryptojob.xyz";

// Категорії залежать від живого пулу вакансій, тож карту рахуємо на запит (з кешу краю, не з бази).
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const lastModified = new Date();
  const entries: MetadataRoute.Sitemap = PAGES.map((p) => ({
    url: new URL(p.path, SITE).toString(),
    lastModified,
    changeFrequency: p.changeFrequency,
    priority: p.priority,
  }));
  const index = await loadCategoryIndex();
  if (!index) return entries;
  // lastmod = коли скан востаннє бачив вакансію (зміст списку міняється разом із ним).
  const seen = new Date(index.updatedMs ?? index.builtMs);
  for (const c of CATEGORY_ROLES) {
    const data = index.roles[c.role];
    if (indexable(data.all)) {
      entries.push({ url: new URL(`/crypto-jobs/${c.slug}`, SITE).toString(), lastModified: seen, changeFrequency: "daily", priority: 0.7 });
    }
    if (indexable(data.remote)) {
      entries.push({ url: new URL(`/crypto-jobs/${c.slug}/remote`, SITE).toString(), lastModified: seen, changeFrequency: "daily", priority: 0.7 });
    }
  }
  return entries;
}
