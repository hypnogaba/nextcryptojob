import { describe, expect, it } from "vitest";
import { crmDb } from "@/test/crm-fixtures";
import { conversion, isBot, loadVisitSeries, loadVisits, pathGroup, recordVisit, refHost, visitorHash } from "./visits";

/** Власний лічильник: групи сторінок, referrer, боти, хеш відвідувача з сіллю дня, без сирих IP. */

const SECRET = "test-session-secret-0123456789abcdef0123456789abcdef";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

describe("pathGroup", () => {
  it("groups pages, keeps no raw paths and skips admin and service paths", () => {
    expect(pathGroup("/")).toBe("home");
    expect(pathGroup("/jobs/j123?x=1")).toBe("jobs");
    expect(pathGroup("/c/abc123")).toBe("card");
    expect(pathGroup("/company/start")).toBe("company_start");
    expect(pathGroup("/company/search")).toBe("company");
    expect(pathGroup("/welcome")).toBe("onboarding");
    expect(pathGroup("/how-scoring-works")).toBe("scoring");
    expect(pathGroup("/terms/companies")).toBe("legal");
    expect(pathGroup("/something-new")).toBe("other");
    expect(pathGroup("/admin")).toBeNull();
    expect(pathGroup("/admin/sources")).toBeNull();
    expect(pathGroup("/api/me")).toBeNull();
    expect(pathGroup("https://evil.example/")).toBeNull();
  });
});

describe("refHost", () => {
  it("keeps only the host, folds www and short social links, and marks our own site as internal", () => {
    expect(refHost("https://www.google.com/search?q=crypto+jobs", "nextcryptojob.xyz")).toBe("google.com");
    expect(refHost("https://t.co/abc", "nextcryptojob.xyz")).toBe("x.com");
    expect(refHost("https://t.me/somechannel", "nextcryptojob.xyz")).toBe("telegram");
    expect(refHost("https://nextcryptojob.xyz/jobs", "nextcryptojob.xyz")).toBe("");
    expect(refHost("", "nextcryptojob.xyz")).toBe("direct");
    expect(refHost("not a url", "nextcryptojob.xyz")).toBe("direct");
  });
});

describe("isBot", () => {
  it("skips crawlers, link previews, headless browsers and scripts, and keeps real browsers", () => {
    for (const ua of [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "TelegramBot (like TwitterBot)",
      "facebookexternalhit/1.1",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0 Safari/537.36",
      "curl/8.4.0",
      "python-requests/2.32",
      "",
    ]) {
      expect(isBot(ua)).toBe(true);
    }
    expect(isBot(UA)).toBe(false);
    expect(isBot("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")).toBe(false);
  });
});

describe("visitorHash", () => {
  it("is the same for one visitor on one day, different on another day, and never contains the IP", async () => {
    const a = await visitorHash(SECRET, "2026-09-14", "203.0.113.7", UA);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await visitorHash(SECRET, "2026-09-14", "203.0.113.7", UA)).toBe(a);
    expect(await visitorHash(SECRET, "2026-09-15", "203.0.113.7", UA)).not.toBe(a);
    expect(await visitorHash(SECRET, "2026-09-14", "203.0.113.8", UA)).not.toBe(a);
    expect(await visitorHash("another-secret", "2026-09-14", "203.0.113.7", UA)).not.toBe(a);
    expect(a).not.toContain("203");
  });
});

describe("recordVisit and loadVisits", () => {
  it("one upsert per view; a visitor is new once a day; the report fills 30 days and counts sign-ups", async () => {
    const { d1, raw } = crmDb();
    const now = new Date("2026-09-14T10:00:00Z");
    const base = { ip: "203.0.113.7", userAgent: UA, ownHost: "nextcryptojob.xyz", secret: SECRET, now };
    expect(await recordVisit(d1, { ...base, pathname: "/", referrer: "https://x.com/post", internal: false })).toBe("counted");
    expect(await recordVisit(d1, { ...base, pathname: "/jobs", internal: true })).toBe("counted");
    expect(await recordVisit(d1, { ...base, pathname: "/", referrer: null, internal: false })).toBe("counted");
    expect(await recordVisit(d1, { ...base, pathname: "/", internal: false, userAgent: "Googlebot/2.1" })).toBe("bot");
    expect(await recordVisit(d1, { ...base, pathname: "/admin", internal: false })).toBe("skipped");
    // Наступного дня той самий відвідувач знову новий.
    await recordVisit(d1, { ...base, pathname: "/", internal: false, now: new Date("2026-09-15T10:00:00Z") });
    expect(raw.prepare("SELECT day, path_group, ref_host, views, uniques FROM visit_days ORDER BY day, path_group, ref_host").all()).toEqual([
      { day: "2026-09-14", path_group: "home", ref_host: "direct", views: 1, uniques: 0 },
      { day: "2026-09-14", path_group: "home", ref_host: "x.com", views: 1, uniques: 1 },
      { day: "2026-09-14", path_group: "jobs", ref_host: "", views: 1, uniques: 0 },
      { day: "2026-09-15", path_group: "home", ref_host: "direct", views: 1, uniques: 1 },
    ]);

    raw.exec("INSERT INTO users (id, email, created_at) VALUES ('u1', 'a@example.com', '2026-09-14 09:00:00')");
    raw.exec("INSERT INTO users (id, email, created_at, is_demo) VALUES ('d1', NULL, '2026-09-14 09:00:00', 1)");
    const r = await loadVisits(d1, now);
    expect(r.days).toHaveLength(30);
    expect(r.days[0]).toEqual({ day: "2026-09-14", views: 3, uniques: 1, signups: 1 });
    expect(r.totals).toEqual({ views: 3, uniques: 1, signups: 1 });
    expect(r.referrers.map((x) => x.key)).toEqual(["x.com", "direct"]);
    expect(r.pages[0]).toEqual({ key: "home", views: 2, uniques: 1 });
  });

  it("says when the counter tables are missing instead of failing the admin page", async () => {
    const { d1 } = crmDb();
    const broken = { ...d1, batch: async () => { throw new Error("D1_ERROR: no such table: visit_days"); } } as unknown as D1Database;
    expect(await loadVisits(broken)).toMatchObject({ available: false, error: expect.stringContaining("0021") });
  });

  it("conversion is sign-ups per unique visitor", () => {
    expect(conversion(3, 25)).toBe("12%");
    expect(conversion(1, 40)).toBe("2.5%");
    expect(conversion(0, 0)).toBe("0%");
  });
});

describe("loadVisitSeries", () => {
  const seed = (raw: { exec: (sql: string) => void }) => {
    raw.exec(`INSERT INTO visit_days (day, path_group, ref_host, views, uniques) VALUES
      ('2026-09-17', 'home', 'direct', 30, 9),
      ('2026-09-16', 'home', 'direct', 149, 11),
      ('2026-09-15', 'home', 'x.com', 140, 18),
      ('2026-08-20', 'home', 'direct', 10, 4)`);
    raw.exec("INSERT INTO users (id, email, created_at) VALUES ('u1', 'a@example.com', '2026-09-17 09:00:00')");
    raw.exec("INSERT INTO users (id, email, created_at, is_demo) VALUES ('d1', NULL, '2026-09-17 09:00:00', 1)");
  };
  const NOW = new Date("2026-09-17T12:00:00Z");

  it("gives 30 days, oldest first, with sign-ups and no demo accounts", async () => {
    const { d1, raw } = crmDb();
    seed(raw);
    const s = await loadVisitSeries(d1, "day", NOW);
    expect(s.points).toHaveLength(30);
    expect(s.points.at(-1)).toMatchObject({ key: "2026-09-17", uniques: 9, views: 30, signups: 1 });
    expect(s.points.at(-2)).toMatchObject({ key: "2026-09-16", uniques: 11, views: 149, signups: 0 });
    expect(s.points[0]!.key).toBe("2026-08-19");
    expect(s.totals.uniques).toBe(42);
  });

  it("adds days up into weeks that start on Monday", async () => {
    const { d1, raw } = crmDb();
    seed(raw);
    const s = await loadVisitSeries(d1, "week", NOW);
    expect(s.points).toHaveLength(12);
    // 17.09 це четвер, тож поточний тиждень почався в понеділок 14.09 і тримає 15, 16 і 17 вересня.
    expect(s.points.at(-1)).toMatchObject({ key: "2026-09-14", uniques: 38, views: 319 });
    expect(s.points.at(-1)!.title).toContain("Week of");
  });

  it("adds days up into calendar months", async () => {
    const { d1, raw } = crmDb();
    seed(raw);
    const s = await loadVisitSeries(d1, "month", NOW);
    expect(s.points).toHaveLength(12);
    expect(s.points.at(-1)).toMatchObject({ key: "2026-09", uniques: 38 });
    expect(s.points.at(-2)).toMatchObject({ key: "2026-08", uniques: 4 });
    expect(s.points[0]!.key).toBe("2025-10");
  });

  it("says visit counting is not on instead of throwing", async () => {
    const stmt = { bind: () => stmt };
    const broken = {
      prepare: () => stmt,
      batch: async () => {
        throw new Error("no such table: visit_days");
      },
    } as unknown as D1Database;
    const s = await loadVisitSeries(broken, "day", NOW);
    expect(s.available).toBe(false);
    expect(s.points).toHaveLength(30);
    expect(s.totals.uniques).toBe(0);
  });
});
