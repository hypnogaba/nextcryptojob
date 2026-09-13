import type { DatabaseSync } from "node:sqlite";
import { migratedD1, type TestDb } from "./sqlite-d1";

/**
 * Копія бази вакансій NextRole (D1 crypto-jobs-agent) для тестів: лише таблиці,
 * які читає адмінка джерел, у тому вигляді, що на живій базі 12.09 (sqlite_master).
 * Лише Node, у Worker не імпортувати.
 */
const SCHEMA = `
CREATE TABLE jobs_cache (
    id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, company TEXT NOT NULL, company_key TEXT NOT NULL,
    title TEXT NOT NULL, location TEXT, remote INTEGER NOT NULL DEFAULT 0, salary_min INTEGER, salary_max INTEGER,
    salary_currency TEXT, source TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', dedupe_key TEXT NOT NULL,
    posted_at TEXT, fetched_at TEXT NOT NULL, country TEXT, summary TEXT, summary_at TEXT);
CREATE INDEX idx_jobs_dedupe ON jobs_cache(dedupe_key);
CREATE TABLE country_boards (
    id TEXT PRIMARY KEY, country TEXT NOT NULL, name TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
    feed_url TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'rss', enabled INTEGER NOT NULL DEFAULT 1,
    added_at TEXT NOT NULL DEFAULT (datetime('now')), salary_period TEXT NOT NULL DEFAULT 'year',
    tags TEXT NOT NULL DEFAULT '[]');
CREATE TABLE getro_collections (
    id TEXT PRIMARY KEY, collection_id INTEGER NOT NULL UNIQUE, label TEXT NOT NULL, url TEXT,
    enabled INTEGER NOT NULL DEFAULT 1, added_at TEXT NOT NULL DEFAULT (datetime('now')),
    tags TEXT NOT NULL DEFAULT '[]');
CREATE TABLE scan_runs (
    id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, distinct_companies INTEGER NOT NULL DEFAULT 0,
    jobs_found INTEGER NOT NULL DEFAULT 0, ladder_reached TEXT, status TEXT NOT NULL DEFAULT 'running', notes TEXT);
CREATE INDEX idx_scan_runs_started ON scan_runs(started_at);
`;

export function nextroleJobsDb(): TestDb {
  const t = migratedD1([]);
  t.raw.exec(SCHEMA);
  return t;
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
                             salary_min, salary_max)
     VALUES (?, ?, ?, ?, 'Engineer', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, `https://example.com/${id}`, company, j.companyKey ?? company.toLowerCase(), j.source,
    JSON.stringify(j.tags ?? ["web3"]), `${id}-dedupe`, j.postedAt ?? null, j.fetchedAt,
    j.salaryMin ?? null, j.salaryMax ?? null,
  );
}
