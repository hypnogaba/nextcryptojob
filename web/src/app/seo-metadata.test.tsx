import { describe, expect, it, vi } from "vitest";
import { buildCategoryIndex, categoryBySlug } from "@/lib/jobs/categories";
import type { PoolJob } from "@/lib/jobs/pool";
import { categoryMetadata } from "./crypto-jobs/category-page";

// Сторінки з побічними залежностями (сесія, база) не тягнемо: важливі лише їхні metadata.
vi.mock("@/lib/auth/session", () => ({ currentUser: async () => null, requireUser: async () => null }));
vi.mock("@/lib/db", () => ({ db: () => ({}), appEnv: () => ({}) }));

const NOW = new Date("2026-09-29T12:00:00Z");
const pj = (): PoolJob => ({
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
});

describe("category metadata", () => {
  const eng = categoryBySlug("engineer")!;

  it("is indexable with 3 jobs and has canonical, a unique title and a description", () => {
    const idx = buildCategoryIndex([pj(), pj(), pj()], NOW);
    const all = categoryMetadata(eng, false, idx);
    const remote = categoryMetadata(eng, true, idx);
    expect(all.robots).toBeUndefined();
    expect(remote.robots).toBeUndefined();
    expect(all.alternates?.canonical).toBe("/crypto-jobs/engineer");
    expect(remote.alternates?.canonical).toBe("/crypto-jobs/engineer/remote");
    expect(remote.title).toBe("Remote crypto engineer jobs");
    expect(all.title).not.toBe(remote.title);
    expect(all.description).not.toBe(remote.description);
  });

  it("is noindex, follow with fewer than 3 jobs or no job pool at all", () => {
    const two = buildCategoryIndex([pj(), pj()], NOW);
    expect(categoryMetadata(eng, false, two).robots).toEqual({ index: false, follow: true });
    expect(categoryMetadata(eng, true, null).robots).toEqual({ index: false, follow: true });
  });
});

describe("service pages stay out of search", () => {
  it("noindexes the sign-in page and the pages behind sign-in", async () => {
    for (const path of ["./login/page", "./welcome/page", "./company/start/page", "./account/page"]) {
      const mod = (await import(/* @vite-ignore */ path)) as { metadata: { robots?: { index?: boolean } } };
      expect(mod.metadata.robots?.index, path).toBe(false);
    }
  });
});

describe("public page metadata", () => {
  it("gives every public page a title of at most 60 characters with the site suffix and a 120 to 155 character description", async () => {
    const pages: [string, string][] = [
      ["./faq/page", "FAQ: finding a crypto job by proof of work"],
      ["./agents/page", "Crypto jobs API and MCP server for AI agents"],
      ["./company/page", "Hire crypto talent by proof of work"],
      ["./leaderboard/page", "Crypto talent leaderboard"],
      ["./scoring/page", "How your crypto talent score works"],
      ["./contact/page", "Contact"],
      ["./terms/page", "Terms"],
    ];
    for (const [path, title] of pages) {
      const mod = (await import(/* @vite-ignore */ path)) as { metadata: { title: string; description: string } };
      expect(mod.metadata.title, path).toBe(title);
      expect(mod.metadata.title.length + " | NextCryptoJob".length, path).toBeLessThanOrEqual(60);
      expect(mod.metadata.description.length, path).toBeGreaterThanOrEqual(120);
      expect(mod.metadata.description.length, path).toBeLessThanOrEqual(155);
    }
    const home = (await import("./page")) as { metadata: { title: string; description: string } };
    expect(home.metadata.description.length).toBeLessThanOrEqual(155);
    expect(home.metadata.description.length).toBeGreaterThanOrEqual(120);
  });
});
