import { readdirSync, readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { migratedD1, type TestDb } from "./sqlite-d1";

/**
 * База вакансій NextCryptoJob (D1 nextcryptojob-jobs) для тестів: справжній SQLite, накочений
 * тими самими міграціями db/jobs, що й продакшн. Пише в неї лише сканер engine; тут рядки
 * кладуть тести. Лише Node, у Worker не імпортувати.
 */
const JOBS_MIGRATIONS = new URL("../../../db/jobs/", import.meta.url);

export function jobsTestDb(): TestDb {
  const t = migratedD1([]);
  for (const f of readdirSync(JOBS_MIGRATIONS).filter((n) => /^\d{4}_.+\.sql$/.test(n)).sort()) {
    t.raw.exec(readFileSync(new URL(f, JOBS_MIGRATIONS), "utf8"));
  }
  return t;
}

/** Джерело поза ATS у реєстрі (таблиця sources): назва й сайт для адмінки. */
export function addSource(raw: DatabaseSync, s: { name: string; label: string; kind?: string; feedUrl?: string; siteUrl?: string | null }): void {
  raw.prepare("INSERT INTO sources (name, label, kind, feed_url, site_url) VALUES (?, ?, ?, ?, ?)").run(
    s.name, s.label, s.kind ?? "rss", s.feedUrl ?? "https://example.com/feed", s.siteUrl === undefined ? "https://example.com" : s.siteUrl);
}

/** Прогін скану (scan_runs), як його пише engine jobs-scan. */
export function addScanRun(raw: DatabaseSync, r: { id: string; startedAt: string; status?: string; kind?: string }): void {
  raw.prepare("INSERT INTO scan_runs (id, kind, started_at, status) VALUES (?, ?, ?, ?)").run(
    r.id, r.kind ?? "scan", r.startedAt, r.status ?? "ok");
}

let seq = 0;

export type CachedJob = {
  source: string;
  fetchedAt: string;
  company?: string;
  companyKey?: string;
  tags?: string[];
  postedAt?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
};

export function addCachedJob(raw: DatabaseSync, j: CachedJob): void {
  const id = `j${++seq}`;
  const company = j.company ?? "Acme";
  raw.prepare(
    `INSERT INTO jobs_cache (id, url, company, company_key, title, source, tags, dedupe_key, posted_at, fetched_at,
                             first_seen_at, salary_min, salary_max)
     VALUES (?, ?, ?, ?, 'Engineer', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, `https://example.com/${id}`, company, j.companyKey ?? company.toLowerCase(), j.source,
    JSON.stringify(j.tags ?? ["web3"]), `${id}-dedupe`, j.postedAt ?? null, j.fetchedAt, j.fetchedAt,
    j.salaryMin ?? null, j.salaryMax ?? null,
  );
}

/** Рядок бази вакансій з усіма стовпцями, які читає пул добірки (POOL_SQL + source). */
export type PoolRowInput = {
  id: string;
  title: string;
  fetchedAt: string;
  company?: string;
  companyKey?: string;
  location?: string | null;
  remote?: boolean;
  salaryMin?: number | null;
  salaryMax?: number | null;
  currency?: string | null;
  tags?: string[];
  postedAt?: string | null;
  country?: string | null;
  dedupeKey?: string;
  source?: string;
  url?: string;
};

export function addPoolJob(raw: DatabaseSync, j: PoolRowInput): void {
  const company = j.company ?? "Chain Labs";
  raw.prepare(
    `INSERT INTO jobs_cache (id, url, company, company_key, title, location, remote, salary_min, salary_max, salary_currency,
                             source, tags, dedupe_key, posted_at, fetched_at, first_seen_at, country)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    j.id, j.url ?? `https://boards.example.com/${j.id}`, company, j.companyKey ?? company.toLowerCase(), j.title,
    j.location === undefined ? "Remote" : j.location, (j.remote ?? true) ? 1 : 0, j.salaryMin ?? null, j.salaryMax ?? null,
    j.currency ?? null, j.source ?? "greenhouse:chainlabs", JSON.stringify(j.tags ?? ["web3"]), j.dedupeKey ?? `${j.id}-d`,
    j.postedAt === undefined ? null : j.postedAt, j.fetchedAt, j.fetchedAt, j.country ?? null,
  );
}
