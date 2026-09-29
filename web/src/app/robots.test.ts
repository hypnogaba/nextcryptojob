import { resolveRobots } from "next/dist/build/webpack/loaders/metadata/resolve-route-data";
import { describe, expect, it, vi } from "vitest";
import { buildCategoryIndex } from "@/lib/jobs/categories";
import type { PoolJob } from "@/lib/jobs/pool";
import robots from "./robots";
import sitemap from "./sitemap";

// Живий зріз категорій підміняємо: інженер має 3 вакансії (2 віддалені), трейдер 2.
const mockIndex = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("./crypto-jobs/data", () => ({ loadCategoryIndex: async () => mockIndex.value }));

const NOW = new Date("2026-09-29T12:00:00Z");
const pj = (p: Partial<PoolJob>): PoolJob => ({
  jobId: `nr_j${Math.random().toString(16).slice(2, 10)}`,
  source: "crawl",
  title: "T",
  company: "C",
  workMode: ["remote"],
  city: null,
  placeText: null,
  salary: null,
  roles: ["engineer"],
  url: "https://x.example/1",
  postedAt: null,
  postedMs: NOW.getTime() - 3_600_000,
  haystack: "",
  companyKey: `k${Math.random()}`,
  location: "Remote",
  country: null,
  seenMs: NOW.getTime() - 7_200_000,
  firstSeenMs: null,
  dedupeKey: null,
  origin: "greenhouse:a",
  salaryEstimate: null,
  ...p,
});

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
  it("lists the public pages with absolute addresses and leaves out everything noindex", async () => {
    mockIndex.value = null;
    const urls = (await sitemap()).map((e) => e.url);
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

  it("leaves out the /terms/companies redirect and the category pages when there is no job pool", async () => {
    mockIndex.value = null;
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls).not.toContain("https://nextcryptojob.xyz/terms/companies");
    expect(urls).toContain("https://nextcryptojob.xyz/crypto-jobs");
    expect(urls.some((u) => u.includes("/crypto-jobs/"))).toBe(false);
  });

  it("adds a category and its /remote page only with at least 3 jobs, lastmod from the scan", async () => {
    const jobs = [
      pj({}),
      pj({}),
      pj({ workMode: ["city"], location: "Lisbon" }),
      pj({ roles: ["trader"] }),
      pj({ roles: ["trader"] }),
    ];
    mockIndex.value = buildCategoryIndex(jobs, NOW);
    const entries = await sitemap();
    const urls = entries.map((e) => e.url);
    // Інженер: 3 усього, 2 віддалені (менше 3): лише основна сторінка.
    expect(urls).toContain("https://nextcryptojob.xyz/crypto-jobs/engineer");
    expect(urls).not.toContain("https://nextcryptojob.xyz/crypto-jobs/engineer/remote");
    // Трейдер: 2 вакансії, сторінки немає.
    expect(urls.some((u) => u.includes("/crypto-jobs/trader"))).toBe(false);
    const eng = entries.find((e) => e.url.endsWith("/crypto-jobs/engineer"))!;
    expect(eng.lastModified).toEqual(new Date(NOW.getTime() - 7_200_000));
    expect(new Set(urls).size).toBe(urls.length);
  });
});
