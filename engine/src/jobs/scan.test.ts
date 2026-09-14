// Скан, розвідка й прибирання на справжньому SQLite зі схемою db/jobs і засівом seed.ts; мережа
// підставна (fixtures з sources/). Та сама база, яку потім читає добірка (loadCrawlPool).
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCrawlPool } from "../digest/jobs.js";
import { readOnlyJobsDb } from "../digest/jobs-db.js";
import { __resetLimiters } from "../limits.js";
import { FakeJobsDb } from "../testing/jobs-fake.js";
import { cryptoLinks, newCompanies, runJobsDiscover } from "./discover.js";
import { jobsDatabaseId } from "./env.js";
import { jobId } from "./ids.js";
import { runJobsPrune } from "./prune.js";
import { DEAD_AFTER_DAYS, runJobsScan, sourceChanges, skipToday } from "./scan.js";
import { type SeedRegistry, seedSql } from "./seed.js";
import { JobsStore, upsertJobsSql } from "./store.js";
import type { SourceState } from "./types.js";

const NOW = new Date("2026-09-14T04:30:00Z");
const DAY = 86_400_000;
const fixture = (name: string): string => readFileSync(new URL(`./sources/fixtures/${name}`, import.meta.url), "utf8");

const REGISTRY: SeedRegistry = {
  version: 1, source: "test",
  companies: [
    { slug: "coinbase", name: "Coinbase", ats_provider: "greenhouse", ats_slug: "coinbase", discovered_via: "seed", enabled: 1, note: null },
    { slug: "kraken", name: "Kraken", ats_provider: "ashby", ats_slug: "kraken.com", discovered_via: "seed", enabled: 1, note: null },
    { slug: "crossmint", name: "Crossmint", ats_provider: "teamtailor", ats_slug: "crossmint.na", discovered_via: "curated", enabled: 1, note: null },
    { slug: "deadco", name: "Dead Co", ats_provider: "lever", ats_slug: "deadco", discovered_via: "seed", enabled: 1, note: null },
    { slug: "offco", name: "Off Co", ats_provider: "lever", ats_slug: "offco", discovered_via: "seed", enabled: 0, note: "disabled at seed" },
  ],
  sources: [
    { name: "board:remote3", label: "Remote3", kind: "rss", feed_url: "https://www.remote3.co/api/rss", site_url: "https://remote3.co", crypto_only: 1, enabled: 1, terms_note: null },
    { name: "aggregator:speedrun", label: "a16z speedrun", kind: "speedrun", feed_url: "https://speedrun-talent-network.com/api/v1", site_url: null, crypto_only: 1, enabled: 1, terms_note: null },
  ],
  getro_collections: [{ collection_id: 1625, label: "Coinbase", url: "https://coinbase.com", enabled: 1 }],
};

let db: FakeJobsDb;
let urls: string[];
let deadAnswers: 404 | 200;

/** Підставна мережа: адреса → файл знімка; дошка deadco відповідає 404 (або порожнім списком). */
const fetchImpl = (async (input: string) => {
  const url = String(input);
  urls.push(url);
  const json = (file: string) => new Response(fixture(file), { status: 200, headers: { "content-type": "application/json" } });
  if (url.includes("boards-api.greenhouse.io")) return json("greenhouse-coinbase-pay.json");
  if (url.includes("api.ashbyhq.com")) return json("ashby-kraken-comp.json");
  if (url.includes("teamtailor.com")) return new Response(fixture("teamtailor-crossmint.rss"), { status: 200 });
  if (url.includes("remote3.co")) return new Response(fixture("remote3.rss"), { status: 200 });
  if (url.includes("api.lever.co/v0/postings/deadco")) return deadAnswers === 404 ? new Response("not found", { status: 404 }) : json("lever-crypto-salary.json");
  if (url.includes("/collections/crypto-web3")) return json("speedrun-collection-crypto.json");
  if (url.includes("/companies?")) return json("speedrun-companies-page.json");
  if (url.includes("/companies/anchorage")) return json("speedrun-company-anchorage.json");
  if (url.includes("/companies/")) return new Response(JSON.stringify({ company: { jobs: [] } }), { status: 200 });
  if (url.includes("api.getro.com")) return json("getro-1625-page.json");
  return new Response("unexpected", { status: 500 });
}) as unknown as typeof fetch;

const o = () => ({ fetchImpl, retries: 0 });
const scan = (store: JobsStore, now = NOW, env: Record<string, string> = {}) =>
  runJobsScan({ store, env, now, log: () => undefined, fetch: o() });

beforeEach(() => {
  __resetLimiters();
  db = new FakeJobsDb(NOW);
  db.sqlite.exec(seedSql(REGISTRY));
  urls = [];
  deadAnswers = 404;
  db.seen.length = 0;
});
afterEach(() => db.close());

const count = (sql: string) => (db.get<{ n: number }>(sql)?.n ?? 0);

describe("jobs-scan", () => {
  it("читає увімкнені джерела, пише лише крипто в межах вікна, id з адреси, стан упалого джерела", async () => {
    const r = await scan(new JobsStore(db, false));
    expect(urls.some((u) => u.includes("offco"))).toBe(false); // вимкнену компанію не читаємо
    expect(r.sources).toMatchObject({ ok: 5, failed: 1 });
    const rows = db.all<{ id: string; url: string; source: string; fetched_at: string; first_seen_at: string; tags: string }>(
      "SELECT id, url, source, fetched_at, first_seen_at, tags FROM jobs_cache ORDER BY url");
    expect(rows.length).toBe(r.kept);
    expect(r.newJobs).toBe(r.kept);
    expect(rows.every((x) => x.id === jobId(x.url) && x.fetched_at === NOW.toISOString() && x.first_seen_at === x.fetched_at)).toBe(true);
    expect(rows.every((x) => (JSON.parse(x.tags) as string[])[0] === "web3")).toBe(true);
    // Старше за 30 днів не йде: Coinbase 29.07, Kraken 13.02, усі ролі Anchorage (29.07 до 12.08).
    expect(rows.some((x) => x.url.includes("8093264"))).toBe(false);
    expect(new Set(rows.map((x) => x.source))).toEqual(new Set(["greenhouse:coinbase", "ashby:kraken.com", "teamtailor:crossmint.na", "board:remote3"]));
    expect(r.dropped.old).toBeGreaterThan(0); // speedrun ріже вікно ще в запиті компанії
    expect(db.all("SELECT source, status, fail_days FROM source_state")).toEqual([{ source: "lever:deadco", status: "failing", fail_days: 1 }]);
    const run = db.get<{ kind: string; status: string; jobs_found: number; jobs_new: number; rows_written: number | null; sources_failed: number }>(
      "SELECT kind, status, jobs_found, jobs_new, rows_written, sources_failed FROM scan_runs");
    expect(run).toMatchObject({ kind: "scan", jobs_found: r.kept, jobs_new: r.kept, sources_failed: 1 });
    expect(run!.status).toBe("ok");
  });

  it("другий день: нових немає, fetched_at оновлено, first_seen_at ні; день збою додається, одужання прибирає рядок", async () => {
    await scan(new JobsStore(db, false));
    const firstSeen = db.all<{ id: string; first_seen_at: string }>("SELECT id, first_seen_at FROM jobs_cache ORDER BY id");
    const r2 = await scan(new JobsStore(db, false), new Date(NOW.getTime() + DAY));
    expect(r2.newJobs).toBe(0);
    expect(db.all("SELECT id, first_seen_at FROM jobs_cache ORDER BY id")).toEqual(firstSeen);
    expect(count(`SELECT COUNT(*) AS n FROM jobs_cache WHERE fetched_at = '${new Date(NOW.getTime() + DAY).toISOString()}'`)).toBe(r2.kept);
    expect(db.get("SELECT fail_days FROM source_state WHERE source = 'lever:deadco'")).toEqual({ fail_days: 2 });
    deadAnswers = 200;
    await scan(new JobsStore(db, false), new Date(NOW.getTime() + 2 * DAY));
    expect(count("SELECT COUNT(*) AS n FROM source_state")).toBe(0);
  });

  it("dead не читається щодня, лише раз на тиждень", async () => {
    const at = new Date(NOW.getTime() - DAY).toISOString();
    db.exec("INSERT INTO source_state (source, status, fail_days, last_error, failed_at, checked_at) VALUES ('lever:deadco', 'dead', 9, '404', ?, ?)", at, at);
    const r = await scan(new JobsStore(db, false));
    expect(urls.some((u) => u.includes("deadco"))).toBe(false);
    expect(r.sources.skippedDead).toBe(1);
    expect(skipToday({ source: "x", status: "dead", failDays: 9, lastError: null, failedAt: at, checkedAt: new Date(NOW.getTime() - 8 * DAY).toISOString() }, NOW)).toBe(false);
  });

  it("--dry: жодного запису в базу, у звіті ті самі рядки й оцінка записів D1", async () => {
    const r = await scan(new JobsStore(db, true));
    expect(db.seen.every((sql) => /^\s*SELECT/i.test(sql))).toBe(true);
    expect(count("SELECT COUNT(*) AS n FROM jobs_cache")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM scan_runs")).toBe(0);
    // 1 на рядок вакансії + scan_runs (2 + 1) + 1 зміна стану джерела.
    expect(r.rowsWritten).toEqual({ estimated: r.kept + 3 + 1, measured: null });
    expect(r.pool.pool).toBeGreaterThan(0);
  });

  it("насухо без бази: реєстр із засіву", async () => {
    const r = await scan(new JobsStore(null, true, REGISTRY));
    expect(r.kept).toBeGreaterThan(0);
    expect(r.newJobs).toBe(r.kept);
  });

  it("Superteam лише з JOBS_SUPERTEAM=1, speedrun вимикається JOBS_SPEEDRUN=0", async () => {
    await scan(new JobsStore(db, true), NOW, { JOBS_SPEEDRUN: "0" });
    expect(urls.some((u) => u.includes("speedrun"))).toBe(false);
    expect(urls.some((u) => u.includes("superteam"))).toBe(false);
  });

  it("добірка читає записане: пул з тієї самої бази, сито й вікна добірки", async () => {
    const r = await scan(new JobsStore(db, false));
    const { jobs, stats } = await loadCrawlPool(readOnlyJobsDb(db), new Date(NOW.getTime() + 60_000));
    expect(stats.fetched).toBe(r.kept);
    expect(jobs.length).toBe(r.pool.pool);
    expect(jobs.every((j) => j.ref.startsWith("nr:j") && j.source === "nextrole")).toBe(true);
  });
});

describe("upsert вакансії", () => {
  const params = (id: string, salary: [number | null, number | null, string | null], fetched: string) =>
    [id, `https://x.example/${id}`, "Acme", "acme", "Engineer", null, 1, ...salary, "board:x", '["web3"]', "acme|engineer", null, fetched, fetched, null];

  it("порожня вилка не стирає відому, нова замінює всю трійку", () => {
    db.sqlite.prepare(upsertJobsSql(1)).run(...params("j1", [100_000, 150_000, "USD"], "2026-09-13T00:00:00.000Z"));
    db.sqlite.prepare(upsertJobsSql(1)).run(...params("j1", [null, null, null], "2026-09-14T00:00:00.000Z"));
    expect(db.get("SELECT salary_min, salary_max, salary_currency, fetched_at, first_seen_at FROM jobs_cache")).toEqual({
      salary_min: 100_000, salary_max: 150_000, salary_currency: "USD", fetched_at: "2026-09-14T00:00:00.000Z", first_seen_at: "2026-09-13T00:00:00.000Z" });
    db.sqlite.prepare(upsertJobsSql(1)).run(...params("j1", [90_000, null, "EUR"], "2026-09-15T00:00:00.000Z"));
    expect(db.get("SELECT salary_min, salary_max, salary_currency FROM jobs_cache")).toEqual({ salary_min: 90_000, salary_max: null, salary_currency: "EUR" });
  });
});

describe("стан джерел", () => {
  const prior = (p: Partial<SourceState>): Map<string, SourceState> =>
    new Map([["a", { source: "a", status: "failing", failDays: 1, lastError: "x", failedAt: "2026-09-13T04:30:00.000Z", checkedAt: "2026-09-13T04:30:00.000Z", ...p }]]);

  it("здорове без рядка: нуль записів; 429 нічого не міняє; той самий день лише час спроби", () => {
    expect(sourceChanges([{ source: "b", ok: true, jobs: [] }], new Map(), NOW)).toEqual([]);
    expect(sourceChanges([{ source: "a", ok: false, jobs: [], rateLimited: true }], prior({}), NOW)).toEqual([]);
    expect(sourceChanges([{ source: "a", ok: false, jobs: [], error: "x" }], prior({ failedAt: NOW.toISOString() }), NOW))
      .toEqual([{ source: "a", kind: "retry", at: NOW.toISOString() }]);
  });

  it(`після ${DEAD_AFTER_DAYS} днів поспіль dead`, () => {
    const [c] = sourceChanges([{ source: "a", ok: false, jobs: [], error: "404" }], prior({ failDays: DEAD_AFTER_DAYS - 1 }), NOW);
    expect(c).toMatchObject({ kind: "fail", status: "dead", failDays: DEAD_AFTER_DAYS });
  });
});

describe("jobs-discover", () => {
  it("speedrun: ATS з адреси подачі; наявна й вимкнена дошка не додається вдруге; Getro вимкнено", async () => {
    const f = (async (input: string) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/companies?")) return new Response(fixture("speedrun-companies-page.json"), { status: 200 });
      if (url.includes("/collections/")) return new Response(fixture("speedrun-collection-crypto.json"), { status: 200 });
      const slug = /\/companies\/([^?]+)/.exec(url)?.[1];
      if (slug) return new Response(JSON.stringify({ company: { jobs: [{ id: `job-${slug}` }] } }), { status: 200 });
      const job = /\/jobs\/job-([^?]+)/.exec(url)?.[1];
      const apply: Record<string, string> = {
        anchorage: "https://jobs.lever.co/anchorage/1", alchemy: "https://jobs.ashbyhq.com/alchemy/2",
        talos: "https://jobs.lever.co/offco/3", "morpho-labs": "https://morpho.org/careers",
      };
      return new Response(JSON.stringify({ job: { apply: { url: apply[job ?? ""] } } }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await runJobsDiscover({ store: new JobsStore(db, false), env: {}, now: NOW, log: () => undefined, fetch: { fetchImpl: f, retries: 0 } });
    expect(r.getro).toBeNull();
    expect(urls.some((u) => u.includes("getro"))).toBe(false);
    expect(r.added.map((c) => [c.slug, c.provider, c.atsSlug, c.discoveredVia])).toEqual([
      ["anchorage", "lever", "anchorage", "speedrun"], ["alchemy", "ashby", "alchemy", "speedrun"],
    ]);
    expect(count("SELECT COUNT(*) AS n FROM companies WHERE discovered_via = 'speedrun'")).toBe(2);
  });

  it("Getro лише з JOBS_GETRO_DISCOVERY=1: організації, які Getro не називає крипто, не беруться", async () => {
    const r = await runJobsDiscover({ store: new JobsStore(db, true), env: { JOBS_GETRO_DISCOVERY: "1", JOBS_SPEEDRUN: "0" },
      now: NOW, log: () => undefined, fetch: o() });
    expect(r.getro).toEqual([{ id: 1625, links: 4, crypto: 3, withAts: 2 }]);
    expect(r.added.map((c) => `${c.provider}:${c.atsSlug}`)).toEqual(["greenhouse:taxbit", "greenhouse:bvnk"]);
    expect(count("SELECT COUNT(*) AS n FROM companies")).toBe(REGISTRY.companies.length); // насухо
  });

  it("newCompanies: не-крипто компанія й зайнятий слаг", () => {
    const out = newCompanies([
      { url: "https://jobs.ashbyhq.com/notion/1", company: "Notion", via: "x" },
      { url: "https://boards.greenhouse.io/kraken/jobs/1", company: "Kraken", via: "x" },
    ], new Set(), new Set(["kraken"]));
    expect(out.map((c) => [c.slug, c.atsSlug])).toEqual([["kraken-greenhouse", "kraken"]]);
    expect(cryptoLinks([{ url: "u", company: "c", industry: "other" }, { url: "u", company: "c", industry: "unknown" }])).toHaveLength(1);
  });
});

describe("jobs-prune", () => {
  it("прибирає небачене N днів, живе не чіпає; менше за живе вікно не можна", async () => {
    await scan(new JobsStore(db, false));
    db.exec("UPDATE jobs_cache SET fetched_at = ? WHERE source = 'board:remote3'", new Date(NOW.getTime() - 40 * DAY).toISOString());
    const stale = count("SELECT COUNT(*) AS n FROM jobs_cache WHERE source = 'board:remote3'");
    const before = count("SELECT COUNT(*) AS n FROM jobs_cache");
    const dry = await runJobsPrune({ store: new JobsStore(db, true), env: {}, now: NOW, log: () => undefined });
    expect(dry.jobs).toBe(stale);
    expect(count("SELECT COUNT(*) AS n FROM jobs_cache")).toBe(before);
    await runJobsPrune({ store: new JobsStore(db, false), env: {}, now: NOW, log: () => undefined });
    expect(count("SELECT COUNT(*) AS n FROM jobs_cache")).toBe(before - stale);
    await expect(runJobsPrune({ store: new JobsStore(db, true), env: {}, days: 2, now: NOW, log: () => undefined })).rejects.toThrow(/більше/);
  });
});

describe("CF_JOBS_D1_DATABASE_ID", () => {
  it("обов'язкова, не база NextRole і не основна база", () => {
    expect(() => jobsDatabaseId({})).toThrow(/CF_JOBS_D1_DATABASE_ID/);
    expect(() => jobsDatabaseId({ CF_JOBS_D1_DATABASE_ID: "0bf4b998-cbdc-474b-b739-eb6e6e7d5a9d" })).toThrow(/NextRole/);
    expect(() => jobsDatabaseId({ CF_JOBS_D1_DATABASE_ID: "abc", CF_D1_DATABASE_ID: "abc" })).toThrow(/окрема/);
    expect(jobsDatabaseId({ CF_JOBS_D1_DATABASE_ID: " new-id " })).toBe("new-id");
  });
});
