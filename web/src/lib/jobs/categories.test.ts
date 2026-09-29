import { describe, expect, it } from "vitest";
import { ROLES } from "@/lib/card/roles";
import {
  buildCategoryIndex,
  categoryBrief,
  categoryBySlug,
  categoryDescription,
  categoryHeading,
  CATEGORY_LIST_SIZE,
  CATEGORY_MIN_JOBS,
  CATEGORY_ROLES,
  indexable,
} from "./categories";
import type { PoolJob } from "./pool";

/**
 * Категорії: кожна роль сайту має сторінку, менше CATEGORY_MIN_JOBS вакансій = не для пошуку,
 * список до 20 з обмеженням на компанію, національні дошки не беремо, тексти вкладаються в межі.
 */

const NOW = new Date("2026-09-29T12:00:00Z");
const T = NOW.getTime();
const H = 3_600_000;

let n = 0;
function job(p: Partial<PoolJob> = {}): PoolJob {
  const id = `j${++n}`;
  return {
    jobId: `nr_${id}`,
    source: "crawl",
    title: "Protocol Engineer",
    company: `Company ${id}`,
    workMode: ["remote"],
    city: null,
    placeText: "Remote",
    salary: null,
    roles: ["engineer"],
    url: `https://boards.example.com/${id}`,
    postedAt: null,
    postedMs: T - 24 * H,
    haystack: "",
    companyKey: `company${id}`,
    location: "Remote",
    country: null,
    seenMs: T - 5 * H,
    firstSeenMs: null,
    dedupeKey: null,
    origin: "greenhouse:a",
    salaryEstimate: null,
    ...p,
  };
}

describe("category roles", () => {
  it("covers every role of the site once, with unique slugs", () => {
    expect(CATEGORY_ROLES.map((c) => c.role).sort()).toEqual(Object.keys(ROLES).sort());
    expect(new Set(CATEGORY_ROLES.map((c) => c.slug)).size).toBe(CATEGORY_ROLES.length);
    expect(categoryBySlug("security-auditor")?.role).toBe("security_auditor");
    expect(categoryBySlug("nope")).toBeNull();
  });

  it("writes plain headings, descriptions of 120 to 155 characters and a brief for /start", () => {
    for (const c of CATEGORY_ROLES) {
      for (const remote of [false, true]) {
        for (const count of [0, 7, 1234, 99_999]) {
          const d = categoryDescription(c, remote, count);
          expect(d.length, `${c.slug} ${remote} ${count}: ${d}`).toBeGreaterThanOrEqual(120);
          expect(d.length, `${c.slug} ${remote} ${count}: ${d}`).toBeLessThanOrEqual(155);
        }
        // Заголовок разом із « | NextCryptoJob» не довший за 60.
        expect(categoryHeading(c, remote).length + " | NextCryptoJob".length).toBeLessThanOrEqual(60);
      }
    }
    const eng = categoryBySlug("engineer")!;
    expect(categoryHeading(eng, true)).toBe("Remote crypto engineer jobs");
    expect(categoryHeading(eng, false)).toBe("Crypto engineer jobs");
    expect(categoryBrief(eng, true)).toBe("Engineer, remote");
  });
});

describe("buildCategoryIndex", () => {
  it("counts per role and remote, puts a multi-role job in each of its roles, skips national boards", () => {
    const idx = buildCategoryIndex(
      [
        job({ roles: ["engineer", "security_auditor"] }),
        job({ workMode: ["city"], location: "Lisbon" }),
        job({ country: "ua" }),
        job({ roles: [] }),
        job({ roles: ["trader"] }),
      ],
      NOW,
    );
    expect(idx.total).toBe(3);
    expect(idx.roles.engineer.all.count).toBe(2);
    expect(idx.roles.engineer.remote.count).toBe(1);
    expect(idx.roles.security_auditor.all.count).toBe(1);
    expect(idx.roles.trader.all.count).toBe(1);
    expect(idx.roles.finance.all.count).toBe(0);
  });

  it("lists at most 20, newest first, two per company, linking to /jobs/<id>", () => {
    const jobs: PoolJob[] = [];
    for (let i = 0; i < 30; i++) jobs.push(job({ postedMs: T - (i + 1) * H }));
    jobs.push(job({ postedMs: null, seenMs: T }));
    const s = buildCategoryIndex(jobs, NOW).roles.engineer.all;
    expect(s.count).toBe(31);
    expect(s.jobs).toHaveLength(CATEGORY_LIST_SIZE);
    const dated = s.jobs.map((j) => j.atMs ?? 0);
    expect([...dated].sort((a, b) => b - a)).toEqual(dated);
    // Вакансія без дати не випереджає датовані, хоч її seenMs найновіший.
    expect(s.jobs.some((j) => j.atMs === T)).toBe(false);
    for (const j of s.jobs) expect(j.href).toMatch(/^\/jobs\/j\d+$/);

    const big = buildCategoryIndex(
      [1, 2, 3].map(() => job({ companyKey: "big", company: "Big Co" })),
      NOW,
    ).roles.engineer.all;
    expect(big.count).toBe(3);
    expect(big.jobs).toHaveLength(2);
  });

  it("makes a page indexable only from CATEGORY_MIN_JOBS jobs", () => {
    const two = buildCategoryIndex([job(), job()], NOW).roles.engineer.all;
    const three = buildCategoryIndex([job(), job(), job()], NOW).roles.engineer.all;
    expect(CATEGORY_MIN_JOBS).toBe(3);
    expect(indexable(two)).toBe(false);
    expect(indexable(three)).toBe(true);
  });
});
