import type { MetadataRoute } from "next";
import { SITE } from "./sitemap";

/**
 * robots.txt: сайт відкритий для пошуковиків, крім переходів "Apply" (/jobs/<id>/apply):
 * це перенаправлення на адресу компанії з лічильником, а не сторінка. Карта сайту: app/sitemap.ts.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/jobs/*/apply"] }],
    sitemap: new URL("/sitemap.xml", SITE).toString(),
  };
}
