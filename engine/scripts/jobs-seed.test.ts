// Засів бази вакансій: форма експорту (лише публічні поля), реєстр з експорту, SQL з реєстру.
// Файли в db/jobs/seed мусять бути саме тим, що дає код: інакше засів розійдеться з правилами.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertReadOnlySql } from "../src/digest/jobs-db.js";
import { seedProblems, type SeedRegistry, seedSql } from "../src/jobs/seed.js";
import { FakeJobsDb } from "../src/testing/jobs-fake.js";
import { buildRegistry, CURATED, DEAD_AT_SEED, EXPORT_FILE, EXPORT_QUERIES, type ExportFile, REGISTRY_FILE, SEED_DISABLED, SQL_FILE } from "./jobs-seed.js";

const exported = JSON.parse(readFileSync(EXPORT_FILE, "utf8")) as ExportFile;
const registry = JSON.parse(readFileSync(REGISTRY_FILE, "utf8")) as SeedRegistry;

describe("експорт (разовий, 14.09.2026)", () => {
  it("лише SELECT і лише публічні стовпці", () => {
    for (const sql of Object.values(EXPORT_QUERIES)) expect(() => assertReadOnlySql(sql)).not.toThrow();
    expect(exported.queries).toEqual(EXPORT_QUERIES);
    const keys = (rows: object[]) => [...new Set(rows.flatMap((r) => Object.keys(r)))].sort();
    expect(keys(exported.companies)).toEqual(["ats_provider", "ats_slug", "discovered_via", "name", "slug"]);
    expect(keys(exported.boards)).toEqual(["enabled", "feed_url", "kind", "label", "name"]);
    expect(keys(exported.getro_collections)).toEqual(["collection_id", "enabled", "label", "url"]);
    expect(Object.keys(exported).sort()).toEqual(["boards", "companies", "database", "exported_at", "getro_collections", "queries"]);
  });

  it("жодних даних про людей: ні пошт, ні імен користувачів, ні числових id Telegram", () => {
    const text = readFileSync(EXPORT_FILE, "utf8");
    expect(text).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
    expect(text).not.toMatch(/telegram|user_id|profile|sent_at/i);
  });
});

describe("реєстр з експорту", () => {
  it("registry.json збігається з buildRegistry(експорт) і проходить перевірку форми", () => {
    expect(buildRegistry(exported).registry).toEqual(registry);
    expect(seedProblems(registry)).toEqual([]);
  });

  it("лише відомі ATS, не-крипто компанії зі списку добірки не йдуть, сумнівні й мертві вимкнені з причиною", () => {
    const { registry: r, skipped } = buildRegistry({
      ...exported,
      companies: [
        { slug: "good", name: "Good Protocol", ats_provider: "ashby", ats_slug: "good", discovered_via: "getro" },
        { slug: "wd", name: "Big Co", ats_provider: "workday", ats_slug: "x|wd1|site", discovered_via: "getro" },
        { slug: "none", name: "No ATS", ats_provider: null, ats_slug: null, discovered_via: "getro" },
        { slug: "crusoe", name: "Crusoe", ats_provider: "ashby", ats_slug: "crusoe", discovered_via: "getro" },
        { slug: "gotenna", name: "goTenna", ats_provider: "lever", ats_slug: "gotenna", discovered_via: "getro" },
        { slug: "lido", name: "Lido", ats_provider: "ashby", ats_slug: "lido", discovered_via: "getro" },
        { slug: "dup", name: "Good Again", ats_provider: "ashby", ats_slug: "GOOD", discovered_via: "getro" },
        { slug: "evil", name: "Evil", ats_provider: "breezy", ats_slug: "evil.com/x", discovered_via: "getro" },
      ],
    });
    const bySlug = new Map(r.companies.map((c) => [c.slug, c]));
    expect(bySlug.get("good")).toMatchObject({ enabled: 1, discovered_via: "seed", note: null });
    expect(bySlug.get("gotenna")).toMatchObject({ enabled: 0, note: expect.stringContaining("not crypto") });
    expect(bySlug.get("lido")).toMatchObject({ enabled: 0, note: expect.stringContaining("did not answer") });
    for (const s of ["wd", "none", "crusoe", "dup", "evil"]) expect(bySlug.has(s)).toBe(false);
    expect(skipped.map((s) => s.slug).sort()).toEqual(["crusoe", "dup", "evil", "none", "wd"]);
    expect(r.companies.map((c) => c.slug)).toContain(CURATED[0]!.slug);
  });

  it("дошки: лише крипто, з рішенням про умови; cryptocurrencyjobs і crypto-careers не беремо", () => {
    expect(registry.sources.map((s) => [s.name, s.kind, s.crypto_only, s.enabled])).toEqual([
      ["aggregator:speedrun", "speedrun", 1, 1],
      ["board:jobstash", "nextjs", 0, 1],
      ["board:remote3", "rss", 1, 1],
      ["board:web3career", "jsonld", 1, 1],
    ]);
    expect(registry.sources.every((s) => s.terms_note)).toBe(true);
  });

  it("числа реєстру (14.09.2026)", () => {
    expect(registry.companies.length).toBe(364);
    expect(registry.companies.filter((c) => c.enabled === 1).length).toBe(320);
    expect(registry.companies.filter((c) => c.enabled === 0).length).toBe(Object.keys(SEED_DISABLED).length + DEAD_AT_SEED.size);
    expect(registry.getro_collections.length).toBe(22);
  });
});

describe("seed.sql", () => {
  it("збігається з seedSql(registry.json)", () => {
    expect(readFileSync(SQL_FILE, "utf8")).toBe(seedSql(registry));
  });

  it("лягає на схему db/jobs, і повторне накочування нічого не змінює", () => {
    const db = new FakeJobsDb();
    db.sqlite.exec(readFileSync(SQL_FILE, "utf8"));
    db.exec("UPDATE companies SET enabled = 0 WHERE slug = ?", registry.companies[0]!.slug);
    db.sqlite.exec(readFileSync(SQL_FILE, "utf8"));
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM companies")?.n).toBe(registry.companies.length);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM companies WHERE enabled = 1")?.n).toBe(319);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sources")?.n).toBe(registry.sources.length);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM getro_collections")?.n).toBe(22);
    db.close();
  });
});
