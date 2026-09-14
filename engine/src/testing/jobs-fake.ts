// Лише для тестів: база вакансій NextCryptoJob на справжньому SQLite, накочена тими самими
// міграціями db/jobs, що й D1 `nextcryptojob-jobs`, тож запити добірки й сканера виконуються насправді.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteD1 } from "./sqlite-d1.js";

export const JOBS_MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../db/jobs");

/** Усі міграції db/jobs за номером. */
export function jobsMigrations(): string[] {
  return readdirSync(JOBS_MIGRATIONS_DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort()
    .map((f) => readFileSync(join(JOBS_MIGRATIONS_DIR, f), "utf8"));
}

export interface FakeJob {
  id: string;
  title: string;
  company?: string;
  companyKey?: string;
  location?: string | null;
  remote?: boolean;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string | null;
  tags?: string[];
  postedAt?: string | null;
  fetchedAt?: string;
  country?: string | null;
  dedupeKey?: string;
  source?: string;
}

/** SQLite зі схемою db/jobs. Лічить усі інструкції, що дійшли до бази, щоб тест бачив, що запис не пройшов. */
export class FakeJobsDb extends SqliteD1 {
  readonly seen: string[] = [];

  constructor(private readonly clock: Date = new Date()) {
    super([]);
    for (const sql of jobsMigrations()) this.sqlite.exec(sql);
    this.beforeStatement = (sql) => { this.seen.push(sql); };
  }

  add(j: FakeJob): void {
    const company = j.company ?? "Acme Protocol";
    const iso = (daysAgo: number) => new Date(this.clock.getTime() - daysAgo * 86_400_000).toISOString();
    const fetched = j.fetchedAt ?? iso(1);
    this.exec(
      `INSERT INTO jobs_cache (id, url, company, company_key, title, location, remote, salary_min, salary_max,
         salary_currency, source, tags, dedupe_key, posted_at, fetched_at, first_seen_at, country)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      j.id, `https://jobs.example/${j.id}`, company, j.companyKey ?? company.toLowerCase(), j.title,
      j.location === undefined ? "Remote" : j.location, j.remote === false ? 0 : 1,
      j.salaryMin ?? null, j.salaryMax ?? null, j.salaryCurrency ?? null, j.source ?? "board:test",
      JSON.stringify(j.tags ?? ["web3"]), j.dedupeKey ?? `${company.toLowerCase()}|${j.title.toLowerCase()}`,
      j.postedAt === undefined ? iso(2) : j.postedAt, fetched, fetched, j.country ?? null);
  }
}
