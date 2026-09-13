import type { MetadataRoute } from "next";

/**
 * robots.txt: сайт відкритий для пошуковиків, крім переходів "Apply" (/jobs/<id>/apply):
 * це перенаправлення на адресу компанії з лічильником, а не сторінка. Карти сайту поки немає.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/jobs/*/apply"] }],
  };
}
