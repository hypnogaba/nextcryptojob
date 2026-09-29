import { cache } from "react";
import { appEnv, db } from "@/lib/db";
import { categoryIndex, type CategoryIndex } from "@/lib/jobs/categories";
import { jobsDb } from "@/lib/jobs-db";

/** SITE_URL для посилань на вакансії компаній; без оточення Worker порожньо (посилання відносні). */
function safeEnv(): { SITE_URL?: string } {
  try {
    return { SITE_URL: appEnv().SITE_URL };
  } catch {
    return {};
  }
}

/**
 * Зріз категорій для сторінки й sitemap. Кеш краю й пам'ять ізолята в lib/jobs/categories.ts;
 * cache() лише не дає generateMetadata і сторінці питати двічі за один запит.
 * Немає бази вакансій: null, сторінка стоїть noindex.
 */
export const loadCategoryIndex = cache(async (): Promise<CategoryIndex | null> => {
  try {
    return await categoryIndex({ db, env: safeEnv(), jobs: jobsDb, now: new Date() });
  } catch (e) {
    console.warn(`categories: not available (${e instanceof Error ? e.name : "unknown"})`);
    return null;
  }
});
