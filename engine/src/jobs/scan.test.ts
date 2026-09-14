// Скан, розвідка й прибирання на справжньому SQLite зі схемою db/jobs і засівом seed.ts; мережа
// підставна (fixtures з sources/). Та сама база, яку потім читає добірка (loadCrawlPool).
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCrawlPool, POOL_SQL, poolParams } from "../digest/jobs.js";
import { readOnlyJobsDb } from "../digest/jobs-db.js";
import { __resetLimiters, __setLimiter } from "../limits.js";
import { FakeJobsDb } from "../testing/jobs-fake.js";
import { cryptoLinks, looseKey, nameLookup, newCompanies, newCompaniesFrom, runJobsDiscover } from "./discover.js";
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

/**
 * Підставний Getro: список компаній по 12 на сторінку (`search/companies`) і сторінка вакансій однієї
 * організації (`search/jobs` з фільтром `organization.id`). Знімки 14.09.2026: сторінка вакансій дошки;
 * список компаній = знята сторінка 0 списку (для 858) плюс організації тієї сторінки вакансій з їхнім
 * числом вакансій (getro-*-companies.json складено з цих двох відповідей).
 */
function getroFake(jobsFile: string, companiesFile: string) {
  const jobs = (JSON.parse(fixture(jobsFile)) as { results: { jobs: Array<{ organization: { id: number } }> } }).results.jobs;
  const companies = (JSON.parse(fixture(companiesFile)) as { results: { companies: unknown[] } }).results.companies;
  return (url: string, init?: RequestInit): Response | null => {
    if (!url.includes("api.getro.com")) return null;
    const body = JSON.parse(String(init?.body ?? "{}")) as { page?: number; filters?: Record<string, number[]> };
    if (url.endsWith("/search/companies")) {
      const page = body.page ?? 0;
      return new Response(JSON.stringify({ results: { count: companies.length, companies: companies.slice(page * 12, page * 12 + 12) } }), { status: 200 });
    }
    const org = body.filters?.["organization.id"]?.[0];
    const list = org === undefined ? jobs : jobs.filter((j) => j.organization.id === org);
    return new Response(JSON.stringify({ results: { count: list.length, jobs: list } }), { status: 200 });
  };
}

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
let web3careerStatus: 200 | 401;
/** Вакансії Coinbase (gh_jid), яких цього разу немає у фіді: роботодавець зняв їх. */
let coinbaseClosed: Set<string>;
/** Kraken (Ashby) відповідає 500: джерело не прочиталось. */
let krakenDown: boolean;

/** Підставна мережа: адреса → файл знімка; дошка deadco відповідає 404 (або порожнім списком). */
const fetchImpl = (async (input: string, init?: RequestInit) => {
  const url = String(input);
  urls.push(url);
  const getro = getroFake("getro-1625-page.json", "getro-1625-companies.json")(url, init);
  if (getro) return getro;
  const json = (file: string) => new Response(fixture(file), { status: 200, headers: { "content-type": "application/json" } });
  if (url.includes("boards-api.greenhouse.io")) {
    const feed = JSON.parse(fixture("greenhouse-coinbase-pay.json")) as { jobs: Array<{ absolute_url: string }> };
    feed.jobs = feed.jobs.filter((j) => ![...coinbaseClosed].some((id) => j.absolute_url.includes(id)));
    return new Response(JSON.stringify(feed), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.includes("api.ashbyhq.com")) return krakenDown ? new Response("upstream error", { status: 500 }) : json("ashby-kraken-comp.json");
  if (url.includes("teamtailor.com")) return new Response(fixture("teamtailor-crossmint.rss"), { status: 200 });
  if (url.includes("remote3.co")) return new Response(fixture("remote3.rss"), { status: 200 });
  if (url.includes("api.lever.co/v0/postings/deadco")) return deadAnswers === 404 ? new Response("not found", { status: 404 }) : json("lever-crypto-salary.json");
  if (url.includes("/collections/crypto-web3")) return json("speedrun-collection-crypto.json");
  if (url.includes("/companies?")) return json("speedrun-companies-page.json");
  if (url.includes("/companies/anchorage")) return json("speedrun-company-anchorage.json");
  if (url.includes("/companies/")) return new Response(JSON.stringify({ company: { jobs: [] } }), { status: 200 });
  if (url.startsWith("https://web3.career/api/v1?")) {
    return web3careerStatus === 200 ? json("web3career-api.json") : new Response("invalid token", { status: 401 });
  }
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
  web3careerStatus = 200;
  coinbaseClosed = new Set();
  krakenDown = false;
  db.seen.length = 0;
  __setLimiter("web3.career", { concurrency: 1, minIntervalMs: 0 });
  __setLimiter("api.getro.com", { concurrency: 1, minIntervalMs: 0 });
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
    // Власний фід роботодавця до 90 днів: Coinbase 28.07 і 20.06 ідуть, Kraken 13.02 ні.
    // Агрегатор (speedrun) до 30 днів: усі ролі Anchorage (29.07 до 12.08) ні.
    expect(rows.some((x) => x.url.includes("8093264"))).toBe(true);
    expect(rows.some((x) => x.url.includes("8013889"))).toBe(true);
    expect(rows.some((x) => x.url.includes("8f237e3a"))).toBe(false);
    expect(rows.some((x) => x.source === "aggregator:speedrun")).toBe(false);
    expect(new Set(rows.map((x) => x.source))).toEqual(new Set(["greenhouse:coinbase", "ashby:kraken.com", "teamtailor:crossmint.na", "board:remote3"]));
    expect(r.dropped.old).toBeGreaterThan(0); // Kraken 13.02; speedrun ріже вікно ще в запиті компанії
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

describe("жива вакансія: є в останньому вдалому скані свого джерела", () => {
  /** id рядків, які зараз узяв би пул добірки (до сита ролей). */
  const live = (at: Date): Set<string> => new Set(db.all<{ id: string }>(POOL_SQL, ...poolParams(at)).map((x) => x.id));
  const idOf = (gh: string) => db.get<{ id: string }>(`SELECT id FROM jobs_cache WHERE url LIKE '%${gh}%'`)!.id;
  const krakenIds = () => db.all<{ id: string }>("SELECT id FROM jobs_cache WHERE source = 'ashby:kraken.com'").map((x) => x.id);

  it("знята з фіду роботодавця не жива з того самого скану; джерело впало: вакансії живі 3 доби від останнього вдалого", async () => {
    await scan(new JobsStore(db, false));
    const closed = idOf("8093264");
    const kraken = krakenIds();
    expect(kraken.length).toBeGreaterThan(0);
    expect(live(NOW)).toContain(closed);

    // Наступного дня Coinbase зняла вакансію, Kraken не відповів.
    coinbaseClosed = new Set(["8093264"]);
    krakenDown = true;
    const day2 = new Date(NOW.getTime() + DAY);
    const r2 = await scan(new JobsStore(db, false), day2);
    expect(r2.bySource.find((s) => s.source === "ashby:kraken.com")!.error).toMatch(/500/);
    const after = live(new Date(day2.getTime() + 60_000));
    expect(after.has(closed)).toBe(false); // рядок у базі є (fetched_at учорашній), але не живий
    expect(count(`SELECT COUNT(*) AS n FROM jobs_cache WHERE id = '${closed}'`)).toBe(1);
    expect(after.has(idOf("8175363"))).toBe(true); // решта Coinbase жива
    for (const id of kraken) expect(after.has(id)).toBe(true); // збій джерела нічого не знімає

    // Kraken не читається й далі: на четверту добу після останнього вдалого скану його вакансій немає.
    const day4 = new Date(NOW.getTime() + 3 * DAY + 60_000);
    await scan(new JobsStore(db, false), day4);
    for (const id of kraken) expect(live(new Date(day4.getTime() + 60_000)).has(id)).toBe(false);
  });

  it("вік: ATS до 90 днів від публікації, дошка до 30; без дати від first_seen_at", async () => {
    const iso = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();
    const add = (id: string, source: string, posted: string | null, firstSeen: string) => db.exec(
      `INSERT INTO jobs_cache (id, url, company, company_key, title, source, tags, dedupe_key, posted_at, fetched_at, first_seen_at)
       VALUES (?, ?, 'Acme', 'acme', 'Engineer', ?, '["web3"]', ?, ?, ?, ?)`, id, `https://x.example/${id}`, source, id, posted, iso(0.1), firstSeen);
    add("ats80", "greenhouse:acme", iso(80), iso(1));
    add("ats95", "ashby:acme", iso(95), iso(1));
    add("board40", "board:web3career", iso(40), iso(1));
    add("board20", "board:jobstash", iso(20), iso(1));
    add("speedrun40", "aggregator:speedrun", iso(40), iso(1));
    add("atsUndated100", "rippling:acme", null, iso(100));
    add("atsUndated60", "bamboohr:acme", null, iso(60));
    add("boardUndated40", "aggregator:superteam", null, iso(40));
    add("unknown40", "careers:acme", iso(40), iso(1));
    expect([...live(NOW)].sort()).toEqual(["ats80", "atsUndated60", "board20"]);
  });
});

describe("jobs-scan: web3.career лише через офіційний API", () => {
  const TOKEN = "w3c_SECRET_token";
  // Рядок sources лишився з часів сторінок (kind 'jsonld', feed_url головна): скан однаково йде в API.
  const addBoard = () => db.exec(`INSERT INTO sources (name, label, kind, feed_url, site_url, crypto_only, enabled)
    VALUES ('board:web3career', 'Web3.career', 'jsonld', 'https://web3.career/', 'https://web3.career', 1, 1)`);
  const api = JSON.parse(fixture("web3career-api.json"))[2] as Array<{ id: number; apply_url: string; date_epoch: number }>;

  it("apply_url у базі байт у байт, id з номера вакансії, сторінок сайту не читаємо", async () => {
    addBoard();
    const r = await scan(new JobsStore(db, false), NOW, { WEB3CAREER_TOKEN: TOKEN });
    expect(urls.filter((u) => u.includes("web3.career")).every((u) => u.startsWith("https://web3.career/api/v1?"))).toBe(true);
    expect(r.bySource.find((s) => s.source === "board:web3career")!.error).toBeUndefined();
    const rows = db.all<{ id: string; url: string }>("SELECT id, url FROM jobs_cache WHERE source = 'board:web3career'");
    const fresh = api.filter((j) => NOW.getTime() - j.date_epoch * 1000 <= 30 * DAY);
    expect(rows.map((x) => x.url).sort()).toEqual(fresh.map((j) => j.apply_url).sort());
    for (const x of rows) expect(x.id).toBe(jobId(`web3career:${api.find((j) => j.apply_url === x.url)!.id}`));
    // Оцінка web3.career лише в salary_est_*, вилка роботодавця лишається порожньою.
    expect(db.get(`SELECT salary_min, salary_max, salary_est_min, salary_est_max, salary_est_currency FROM jobs_cache WHERE id = '${jobId("web3career:154039")}'`))
      .toEqual({ salary_min: null, salary_max: null, salary_est_min: 180_000, salary_est_max: 225_000, salary_est_currency: "USD" });
    expect(r.pool.withEstimateOnly).toBeGreaterThan(0);
  });

  it("без WEB3CAREER_TOKEN джерело падає з ясною причиною і нікуди не ходить", async () => {
    addBoard();
    const r = await scan(new JobsStore(db, false));
    expect(urls.some((u) => u.includes("web3.career"))).toBe(false);
    expect(r.bySource.find((s) => s.source === "board:web3career")!.error).toMatch(/WEB3CAREER_TOKEN/);
  });

  it("токен не потрапляє ні в source_state, ні в scan_runs, ні в журнал", async () => {
    addBoard();
    web3careerStatus = 401;
    const lines: string[] = [];
    await runJobsScan({ store: new JobsStore(db, false), env: { WEB3CAREER_TOKEN: TOKEN }, now: NOW, log: (l) => lines.push(l), fetch: o() });
    const state = db.get<{ last_error: string }>("SELECT last_error FROM source_state WHERE source = 'board:web3career'");
    expect(state!.last_error).toMatch(/401/);
    const notes = db.all<{ notes: string }>("SELECT notes FROM scan_runs").map((x) => x.notes).join("\n");
    for (const text of [state!.last_error, notes, lines.join("\n")]) expect(text).not.toContain(TOKEN);
  });
});

describe("upsert вакансії", () => {
  const params = (id: string, salary: [number | null, number | null, string | null], fetched: string,
                  est: [number | null, number | null, string | null] = [null, null, null]) =>
    [id, `https://x.example/${id}`, "Acme", "acme", "Engineer", null, 1, ...salary, "board:x", '["web3"]', "acme|engineer", null, fetched, fetched, null, ...est];

  it("порожня вилка не стирає відому, нова замінює всю трійку", () => {
    db.sqlite.prepare(upsertJobsSql(1)).run(...params("j1", [100_000, 150_000, "USD"], "2026-09-13T00:00:00.000Z"));
    db.sqlite.prepare(upsertJobsSql(1)).run(...params("j1", [null, null, null], "2026-09-14T00:00:00.000Z"));
    expect(db.get("SELECT salary_min, salary_max, salary_currency, fetched_at, first_seen_at FROM jobs_cache")).toEqual({
      salary_min: 100_000, salary_max: 150_000, salary_currency: "USD", fetched_at: "2026-09-14T00:00:00.000Z", first_seen_at: "2026-09-13T00:00:00.000Z" });
    db.sqlite.prepare(upsertJobsSql(1)).run(...params("j1", [90_000, null, "EUR"], "2026-09-15T00:00:00.000Z"));
    expect(db.get("SELECT salary_min, salary_max, salary_currency FROM jobs_cache")).toEqual({ salary_min: 90_000, salary_max: null, salary_currency: "EUR" });
  });

  it("оцінка дошки окремою трійкою: не стирається порожньою й вилки не чіпає", () => {
    db.sqlite.prepare(upsertJobsSql(1)).run(...params("j2", [null, null, null], "2026-09-13T00:00:00.000Z", [180_000, 225_000, "USD"]));
    db.sqlite.prepare(upsertJobsSql(1)).run(...params("j2", [null, null, null], "2026-09-14T00:00:00.000Z"));
    expect(db.get("SELECT salary_min, salary_max, salary_est_min, salary_est_max, salary_est_currency FROM jobs_cache WHERE id = 'j2'")).toEqual({
      salary_min: null, salary_max: null, salary_est_min: 180_000, salary_est_max: 225_000, salary_est_currency: "USD" });
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

  it("Getro лише з JOBS_GETRO_DISCOVERY=1 і лише дошки job_boards; фонд 'tagged': Notion не береться", async () => {
    db.exec(`INSERT INTO job_boards (slug, label, kind, url, platform, platform_id, decision, crypto_scope, reason, checked_at)
      VALUES ('coinbase-ventures', 'Coinbase Ventures', 'fund', 'https://coinbase.getro.com/jobs', 'getro', '1625', 'discover', 'tagged', 't', '2026-09-14'),
             ('pantera', 'Pantera', 'fund', 'https://jobs.panteracapital.com/jobs', 'consider', NULL, 'manual', 'all', 't', '2026-09-14')`);
    const r = await runJobsDiscover({ store: new JobsStore(db, true), env: { JOBS_GETRO_DISCOVERY: "1", JOBS_SPEEDRUN: "0" },
      now: NOW, log: () => undefined, fetch: o() });
    expect(r.getro).toEqual([{ board: "coinbase-ventures", id: 1625, label: "Coinbase Ventures", companies: 4, withJobs: 4, cryptoOrgs: 3,
      known: 0, ats: 2, viaCareerPage: 0, hostedOnly: 0, otherAts: 1, unresolved: 0, knownBoard: 0, added: 2, requests: 4 }]);
    expect(r.added.map((c) => `${c.provider}:${c.atsSlug} ${c.discoveredVia}`)).toEqual(["greenhouse:taxbit getro:1625", "greenhouse:bvnk getro:1625"]);
    expect(r.added[0]!.note).toMatch(/^found via getro:1625 \(Coinbase Ventures board, only there\): its jobs link greenhouse:taxbit \(\d+ open on 2026-09-14\)$/);
    expect(r.otherAts).toEqual([{ company: "VALR", boards: ["coinbase-ventures"], jobs: 1, detail: "hibob" }]);
    // Список компаній (1 сторінка) і вакансії лише трьох крипто-компаній, яких реєстр не знає; Notion не читається.
    expect(urls.filter((u) => u.includes("api.getro.com"))).toHaveLength(4);
    expect(urls.some((u) => u.includes("consider") || u.includes("pantera"))).toBe(false);
    expect(count("SELECT COUNT(*) AS n FROM companies")).toBe(REGISTRY.companies.length); // насухо
  });

  it("дошка екосистеми (jobs.solana.com): відомих не читає, нові дошки ATS лише після живої відповіді API; лише Getro й чужий ATS окремо", async () => {
    db.exec(`INSERT INTO job_boards (slug, label, kind, url, platform, platform_id, decision, crypto_scope, reason, checked_at)
      VALUES ('solana', 'Solana', 'ecosystem', 'https://jobs.solana.com/jobs', 'getro', '858', 'discover', 'all', 't', '2026-09-14')`);
    // Phantom уже в реєстрі під іншою, живою дошкою, Alchemy як «Alchemy Labs», Anza: їхніх вакансій розвідка не
    // читає. Akash Network є лише з вимкненою дошкою: читає.
    db.exec(`INSERT INTO companies (slug, name, ats_provider, ats_slug, discovered_via) VALUES
      ('phantom-old', 'Phantom', 'lever', 'phantom-old', 'seed'), ('alchemy', 'Alchemy Labs', 'ashby', 'alchemy', 'seed'),
      ('anza', 'Anza', 'workable', 'anza-xyz', 'seed')`);
    db.exec(`INSERT INTO companies (slug, name, ats_provider, ats_slug, discovered_via, enabled) VALUES ('akash', 'Akash Network', 'lever', 'akashnetwork', 'seed', 0)`);
    const fake = getroFake("getro-858-page.json", "getro-858-companies.json");
    const f = (async (input: string, init?: RequestInit) => {
      const url = String(input);
      const g = fake(url, init);
      if (g) { urls.push(url); return g; }
      if (url.includes("api.ashbyhq.com/posting-api/job-board/rain")) { urls.push(url); return new Response("not found", { status: 404 }); }
      return fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const r = await runJobsDiscover({ store: new JobsStore(db, false), env: { JOBS_GETRO_DISCOVERY: "1", JOBS_SPEEDRUN: "0" },
      now: NOW, log: () => undefined, fetch: { fetchImpl: f, retries: 0 } });
    expect(r.added.map((c) => `${c.provider}:${c.atsSlug}`)).toEqual([
      "greenhouse:ondofinance", "ashby:dourolabs.xyz", "ashby:batoncorporation", "ashby:wormholelabs", "ashby:fomo-labs"]);
    // 23 компанії, 16 з вакансіями; Perle на списку не-крипто компаній добірки (engine/src/digest/clean.ts).
    // Відомі за назвою: Alchemy («Alchemy Labs»), Anza, Phantom, Crossmint (REGISTRY). Запитів: 2 сторінки компаній + 11 організацій.
    expect(r.getro).toEqual([{ board: "solana", id: 858, label: "Solana", companies: 23, withJobs: 16, cryptoOrgs: 15, known: 4,
      ats: 7, viaCareerPage: 0, hostedOnly: 1, otherAts: 1, unresolved: 2, knownBoard: 0, added: 6, requests: 13 }]);
    expect(r.hostedOnly.map((x) => x.company)).toEqual(["Arcade"]);
    expect(r.otherAts.map((x) => `${x.company} ${x.detail}`)).toEqual(["Morse screenloop"]);
    expect(r.unresolved.map((x) => `${x.company} ${x.detail}`)).toEqual(["Akash Network no jobs listed", "Anchorage Digital no jobs listed"]);
    expect(r.unverified.map((x) => `${x.company} ${x.detail?.slice(0, 10)}`)).toEqual(["Rain ashby:rain"]);
    // Живий прогін: у реєстр пішли лише перевірені, з приміткою, звідки відомо.
    expect(db.all<{ slug: string; discovered_via: string; enabled: number }>(
      "SELECT slug, discovered_via, enabled FROM companies WHERE discovered_via LIKE 'getro:%' ORDER BY slug"))
      .toEqual(["batoncorporation", "dourolabs.xyz", "fomo-labs", "ondofinance", "wormholelabs"]
        .map((slug) => ({ slug, discovered_via: "getro:858", enabled: 1 })));
    // Відомих за назвою вакансій не читали.
    const orgQueries = urls.filter((u) => u.includes("api.getro.com") && u.endsWith("/search/jobs"));
    expect(orgQueries).toHaveLength(11);
    // Вакансій з Getro в базі немає, лише розвідка.
    expect(count("SELECT COUNT(*) AS n FROM jobs_cache")).toBe(0);
  });

  it("та сама компанія за назвою: «Ethena Labs» і «Ethena» так, «Solana Foundation» і «Solana Labs» ні; дошка Notion не береться", () => {
    const known = nameLookup(new Map([["ethena", true], ["solana labs", true], ["akash network", false]]));
    expect(known("Ethena Labs")).toBe(true);
    expect(known("Solana Foundation")).toBeUndefined();
    expect(known("Solana")).toBe(true);
    expect(known("Akash")).toBe(false);
    expect(looseKey("The Graph Foundation")).toBe("graph");
    const { added, skipped } = newCompaniesFrom([
      { provider: "ashby", slug: "notion", company: "PropellerHeads", via: "getro:1440" },
      { provider: "ashby", slug: "ethena", company: "Ethena Labs", via: "getro:1" },
      { provider: "ashby", slug: "akash", company: "Akash", via: "getro:1" },
    ], new Set(), new Set(), new Map([["ethena", true], ["akash network", false]]));
    expect(added.map((c) => [c.slug, c.note])).toEqual([["akash", "found via getro:1: ashby:akash; the same company is in the registry only with a disabled board"]]);
    expect(skipped).toEqual([{ company: "Ethena Labs", board: "ashby:ethena", why: "known-name" }]);
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
