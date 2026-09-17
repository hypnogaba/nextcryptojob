import { beforeEach, describe, expect, it } from "vitest";
import { loadJobsSupply, loadPeopleDemand, median, resetDemandCache } from "./demand";
import { readOnlyJobsDb } from "@/lib/jobs-db";
import { crmDb, run } from "@/test/crm-fixtures";
import { jobsTestDb } from "@/test/jobs-db";
import type { TestDb } from "@/test/sqlite-d1";

/**
 * Попит і пропозиція для /admin/demand: ролі й слова людей з основної бази, живі вакансії
 * за сферою з бази вакансій.
 */

const NOW = new Date("2026-09-17T12:00:00Z");

let db: TestDb;

beforeEach(() => {
  db = crmDb();
  resetDemandCache();
});

type JobRow = { id: string; company: string; location?: string | null; remote?: number; salaryMin?: number | null; tags: string[]; fetchedAt: string };

/** Свій рядок вакансії: тут потрібні location і remote, яких немає в addCachedJob. */
function addJob(raw: Parameters<typeof run>[0], j: JobRow): void {
  run(
    raw,
    `INSERT INTO jobs_cache (id, url, company, company_key, title, location, remote, salary_min, source, tags, dedupe_key, fetched_at, first_seen_at)
     VALUES (?, ?, ?, ?, 'Engineer', ?, ?, ?, 'greenhouse:x', ?, ?, ?, ?)`,
    j.id,
    `https://example.com/${j.id}`,
    j.company,
    j.company.toLowerCase(),
    j.location ?? null,
    j.remote ?? 0,
    j.salaryMin ?? null,
    JSON.stringify(j.tags),
    `${j.id}-dedupe`,
    j.fetchedAt,
    j.fetchedAt,
  );
}

function addPerson(id: string, cols: Record<string, string | number | null>): void {
  const keys = Object.keys(cols);
  run(
    db.raw,
    `INSERT INTO users (id, ${keys.join(", ")}) VALUES (?, ${keys.map(() => "?").join(", ")})`,
    id,
    ...keys.map((k) => cols[k]!),
  );
}

describe("what people look for", () => {
  it("counts roles, places and pay, and keeps their own words newest first", async () => {
    addPerson("u1", {
      roles: '["engineer","devrel"]',
      remote_mode: "remote",
      salary_min: 90_000,
      salary_currency: "usd",
      target_text: "Rust work on a Solana team",
      created_at: "2026-09-16 10:00:00",
    });
    addPerson("u2", {
      roles: '["engineer"]',
      remote_mode: "city",
      city: "Lisbon",
      salary_min: 70_000,
      salary_currency: "USD",
      role_text: "Tokenomics designer",
      created_at: "2026-09-17 10:00:00",
    });
    addPerson("u3", { roles: "[]", created_at: "2026-09-10 10:00:00" });

    const p = await loadPeopleDemand(db.d1);
    expect(p.total).toBe(3);
    expect(p.withBrief).toBe(2);
    expect(p.roles).toEqual([
      { key: "engineer", label: "Engineer", n: 2 },
      { key: "devrel", label: "DevRel", n: 1 },
    ]);
    expect(p.places.find((x) => x.key === "remote")).toEqual({ key: "remote", label: "Remote only", n: 1 });
    expect(p.places.find((x) => x.key === "not said")?.n).toBe(1);
    expect(p.cities).toEqual([{ key: "Lisbon", label: "Lisbon", n: 1 }]);
    // Валюта в одному регістрі, медіана двох чисел це середнє.
    expect(p.pay).toEqual([{ currency: "USD", people: 2, median: 80_000 }]);
    // Найновіші слова зверху, і своя роль теж рахується за слова людини.
    expect(p.words[0]).toMatchObject({ text: "Tokenomics designer", kind: "role" });
    expect(p.words[1]).toMatchObject({ text: "Rust work on a Solana team", kind: "target" });
  });

  it("does not count demo people", async () => {
    addPerson("d1", { roles: '["trader"]', is_demo: 1, created_at: "2026-09-17 10:00:00" });
    const p = await loadPeopleDemand(db.d1);
    expect(p.total).toBe(0);
    expect(p.roles).toEqual([]);
  });
});

describe("what we have", () => {
  it("counts live jobs by field, place and employer, and ignores jobs older than the live window", async () => {
    const t = jobsTestDb();
    addJob(t.raw, { id: "j1", company: "Coinbase", location: "Remote", remote: 1, tags: ["web3", "engineering", "remote"], fetchedAt: "2026-09-17T04:40:00.000Z" });
    addJob(t.raw, { id: "j2", company: "Coinbase", location: "Lisbon", salaryMin: 80_000, tags: ["web3", "engineering"], fetchedAt: "2026-09-17T04:40:00.000Z" });
    addJob(t.raw, { id: "j3", company: "Binance", location: "Lisbon", tags: ["web3", "marketing"], fetchedAt: "2026-09-17T04:40:00.000Z" });
    // Стара: скан не бачив її 5 днів.
    addJob(t.raw, { id: "j4", company: "Binance", tags: ["web3", "marketing"], fetchedAt: "2026-09-12T04:40:00.000Z" });

    const j = await loadJobsSupply(readOnlyJobsDb(t.d1), NOW);
    expect(j.available).toBe(true);
    expect(j.live).toBe(3);
    expect(j.remote).toBe(1);
    expect(j.withSalary).toBe(1);
    expect(j.companies).toBe(2);
    expect(j.spheres).toEqual([
      { key: "engineering", label: "Engineering", n: 2 },
      { key: "marketing", label: "Marketing", n: 1 },
    ]);
    expect(j.locations[0]).toEqual({ key: "Lisbon", label: "Lisbon", n: 2 });
    expect(j.topCompanies[0]).toEqual({ key: "Coinbase", label: "Coinbase", n: 2 });
  });

  it("says it could not read instead of throwing when the job database is empty of tables", async () => {
    const broken = { all: async () => { throw new Error("no such table: jobs_cache"); } } as never;
    const j = await loadJobsSupply(broken, NOW);
    expect(j.available).toBe(false);
    expect(j.error).toContain("no such table");
    expect(j.live).toBe(0);
  });
});

describe("median", () => {
  it("takes the middle of an odd list and the average of the two middles of an even one", () => {
    expect(median([1, 5, 9])).toBe(5);
    expect(median([1, 4])).toBe(3);
    expect(median([])).toBe(0);
  });
});
