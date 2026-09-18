import { resolveRobots } from "next/dist/build/webpack/loaders/metadata/resolve-route-data";
import { describe, expect, it } from "vitest";
import robots from "./robots";
import sitemap from "./sitemap";

/** robots.txt, як його віддає Next: сайт відкритий, закрито лише перенаправлення "Apply". */
describe("robots.txt", () => {
  it("disallows only /jobs/*/apply, allows the rest and names the sitemap", () => {
    const text = resolveRobots(robots());
    expect(text).toBe("User-Agent: *\nAllow: /\nDisallow: /jobs/*/apply\n\nSitemap: https://nextcryptojob.xyz/sitemap.xml\n");
  });
});

/**
 * Карта сайту: лише те, що ми справді пускаємо в пошук. Вакансії зі сканування й картки людей
 * стоять noindex, тож у карті їх бути не може: інакше ми самі просимо Google по них прийти.
 */
describe("sitemap.xml", () => {
  it("lists the public pages with absolute addresses and leaves out everything noindex", () => {
    const urls = sitemap().map((e) => e.url);
    expect(urls).toContain("https://nextcryptojob.xyz/");
    for (const p of ["/scoring", "/company", "/leaderboard", "/faq", "/sources", "/privacy"]) {
      expect(urls).toContain(`https://nextcryptojob.xyz${p}`);
    }
    for (const u of urls) expect(u.startsWith("https://nextcryptojob.xyz")).toBe(true);
    // Нічого, що стоїть noindex або за входом.
    for (const gone of ["/jobs", "/c/", "/admin", "/account", "/settings", "/login", "/welcome", "/start"]) {
      expect(urls.some((u) => u.includes(gone))).toBe(false);
    }
    expect(new Set(urls).size).toBe(urls.length);
  });
});
